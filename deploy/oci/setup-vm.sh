#!/usr/bin/env bash
# Prepares a fresh Oracle Cloud VM to run Velnor: Docker, the two ports Slack needs
# opened in the host firewall, generated secrets, and the stack itself.
#
#   sudo ./setup-vm.sh
#
# Safe to re-run: it never overwrites a secret that already has a value, and it
# rebuilds the stack with whatever is in .env at the time.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

say()  { printf '\n\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run this with sudo: sudo ./setup-vm.sh"

say "1/6 Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl git openssl >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl git openssl >/dev/null
  else
    die "neither apt-get nor dnf found: this script expects Ubuntu or Oracle Linux"
  fi
  # Docker's own installer handles both distributions and the compose plugin.
  curl -fsSL https://get.docker.com | sh
else
  echo "docker already present: $(docker --version)"
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing; re-run after installing docker-compose-plugin"

say "2/6 Opening ports 80 and 443 in the host firewall"
# Oracle's images ship an iptables ruleset that REJECTs everything but SSH even
# when firewalld is inactive, so the security list alone is not enough.
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
  echo "firewalld: http and https allowed"
elif command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
  echo "ufw: 80 and 443 allowed"
elif command -v iptables >/dev/null 2>&1 && iptables -S INPUT 2>/dev/null | grep -q -- "-j REJECT"; then
  for port in 80 443; do
    iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null \
      || iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
  done
  if [[ -f /etc/sysconfig/iptables ]]; then
    iptables-save > /etc/sysconfig/iptables
    systemctl enable iptables >/dev/null 2>&1 || true
  elif command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null
  elif [[ -d /etc/iptables ]]; then
    iptables-save > /etc/iptables/rules.v4
  else
    warn "iptables rules added but not persisted; they will vanish on reboot"
  fi
  echo "iptables: 80 and 443 allowed ahead of the default REJECT"
else
  echo "no active host firewall found; nothing to open here"
fi

say "3/6 Preparing .env"
[[ -f .env ]] || cp .env.example .env
# Add newly introduced required secrets to existing installations before the
# idempotent generation loop below; old .env files do not inherit .env.example.
if ! grep -q '^VELNOR_PROVISIONING_SECRET=' .env; then
  printf '\nVELNOR_PROVISIONING_SECRET=\n' >> .env
fi
if ! grep -q '^VELNOR_PUBLIC_URL=' .env; then
  printf '\nVELNOR_PUBLIC_URL=\n' >> .env
fi
chmod 600 .env

: > .env.tmp
while IFS= read -r line; do
  case "$line" in
    VELNOR_SHARED_SECRET=*|VELNOR_SECRET_KEY=*|VELNOR_TENANT_TOKEN_SECRET=*|VELNOR_PROVISIONING_SECRET=*|CRON_SECRET=*)
      name="${line%%=*}"
      value="${line#*=}"
      if [[ -z "$value" ]]; then
        printf '%s=%s\n' "$name" "$(openssl rand -hex 32)" >> .env.tmp
        echo "generated $name"
      else
        printf '%s\n' "$line" >> .env.tmp
      fi
      ;;
    *) printf '%s\n' "$line" >> .env.tmp ;;
  esac
done < .env
mv .env.tmp .env
chmod 600 .env

if grep -qE '^VELNOR_HOST=(localhost)?$' .env; then
  public_ip="$(curl -fsS --max-time 8 https://ifconfig.me 2>/dev/null || true)"
  if [[ -n "$public_ip" ]]; then
    # sslip.io resolves this name straight back to the IP, which is what lets
    # Let's Encrypt issue a certificate without owning a domain.
    sed -i "s|^VELNOR_HOST=.*|VELNOR_HOST=${public_ip}.sslip.io|" .env
    echo "VELNOR_HOST set to ${public_ip}.sslip.io"
  else
    warn "could not detect the public IP; set VELNOR_HOST in .env to <public-ip>.sslip.io"
  fi
fi

public_url="$(grep -E '^VELNOR_PUBLIC_URL=' .env | cut -d= -f2-)"
if [[ -z "$public_url" || "$public_url" == "https://your-public-domain.example" ]]; then
  warn "Set VELNOR_PUBLIC_URL in .env to the canonical public HTTPS API origin (for example https://api.velnor.ai) before using Google OAuth or Twilio webhooks."
fi

missing=()
grep -qE '^SLACK_BOT_TOKEN=\S' .env || missing+=("SLACK_BOT_TOKEN")
grep -qE '^SLACK_SIGNING_SECRET=\S' .env || missing+=("SLACK_SIGNING_SECRET")
if (( ${#missing[@]} )); then
  warn "These are still blank in .env: ${missing[*]}"
  warn "Fill them in and re-run this script. The websocket-facing routes stay dark until both are set."
fi

say "4/6 Building and starting the stack (first build takes a few minutes on ARM)"
docker compose up -d --build

say "5/6 Waiting for the app to answer"
healthy=""
for _ in $(seq 1 40); do
  if curl -fsS --max-time 3 http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    healthy=yes
    echo "app is healthy on 127.0.0.1:8080"
    break
  fi
  sleep 3
done
if [[ -z "$healthy" ]]; then
  docker compose logs --tail 40 velnor || true
  die "app never became healthy"
fi

host="$(grep -E '^VELNOR_HOST=' .env | cut -d= -f2-)"
if [[ "$host" != "localhost" && -n "$host" ]]; then
  echo "waiting for the certificate on https://$host (ACME can take ~30s)..."
  for _ in $(seq 1 24); do
    if curl -fsS --max-time 5 "https://$host/api/health" >/dev/null 2>&1; then
      printf '\n\033[32mVelnor is live: https://%s\033[0m\n' "$host"
      break
    fi
    sleep 5
  done
  warn "https is not answering yet. Check ports 80/443 in the OCI security list, then: docker compose logs caddy"
fi
printf '\nStack is running. Public URL once TLS is issued: https://%s\n' "$host"

say "6/6 Scheduling the reminder sweep"
# vercel.json used to fire /api/cron/reminders every 15 minutes. Nothing does that
# on a plain VM, so reminders would sit in state and never be delivered.
cat > /etc/systemd/system/velnor-reminders.service <<UNIT
[Unit]
Description=Velnor reminder sweep
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash ${here}/run-reminders.sh
UNIT

cat > /etc/systemd/system/velnor-reminders.timer <<'UNIT'
[Unit]
Description=Run the Velnor reminder sweep every 15 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=15min
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now velnor-reminders.timer >/dev/null
systemctl start velnor-reminders.service \
  && echo "reminder sweep works; timer runs every 15 minutes" \
  || warn "the first reminder sweep failed: journalctl -u velnor-reminders.service"

printf '\nDone. Logs: docker compose logs -f velnor | Sweeps: journalctl -u velnor-reminders\n'
