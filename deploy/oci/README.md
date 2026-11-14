# Velnor on a single Oracle Cloud VM

One Always Free VM runs the app and the TLS terminator. Caddy answers on 80 and 443
and proxies to Velnor on loopback, so the agent is reachable over https (Slack
requires it) and port 8080 stays closed to the internet.

## 1. Create the instance (console)

Compute → Instances → Create instance.

- **Image:** Ubuntu 24.04 (Oracle Linux 9 works too, the script handles both)
- **Shape:** `VM.Standard.A1.Flex`, the Always Free Ampere allowance is 4 OCPU / 24 GB
  which is far more than Velnor needs. If the region reports no capacity, wait for
  it or fall back to `VM.Standard.E2.1.Micro`
- **SSH keys:** upload yours, or let the console generate a pair and download it
- Note the **public IP** when it finishes

## 2. Open the ports

Networking → VCN → Security Lists → the default list for the subnet → Add ingress rules:

| Source     | Protocol | Destination port |
|------------|----------|------------------|
| 0.0.0.0/0  | TCP      | 80               |
| 0.0.0.0/0  | TCP      | 443              |

Port 80 is not optional: Let's Encrypt validates the certificate over it. If the VCN
uses network security groups instead of a security list, add the rules there.

## 3. Install

```bash
ssh ubuntu@<public-ip>

sudo apt-get install -y git            # or: sudo dnf install -y git
sudo git clone https://github.com/vectolith/velnor.git /opt/velnor
cd /opt/velnor/deploy/oci
sudo ./setup-vm.sh
```

If the repository is private, clone it with a token
(`https://<token>@github.com/vectolith/velnor.git`) or copy the working tree up with
`scp -r`. The script assumes the repo already exists on the VM.

The script installs Docker, opens 80/443 in the host firewall, generates
`VELNOR_SHARED_SECRET`, `VELNOR_SECRET_KEY`, `VELNOR_TENANT_TOKEN_SECRET`, `VELNOR_PROVISIONING_SECRET` and `CRON_SECRET` into `.env`, sets
`VELNOR_HOST` to `<public-ip>.sslip.io`, builds the image and waits for
`/api/health`. Set `VELNOR_PUBLIC_URL` to the canonical public HTTPS API origin (normally `https://api.velnor.ai` when using the Cloudflare gateway) in `.env`; do not use the private/origin hostname if providers call the gateway hostname. Configure a trusted identity gateway before calling the chat, settings, Siri, TTS, or LoRA APIs; the repository verifies identity tokens but does not issue them.

## 4. Fill in Slack, then re-run

```bash
sudo nano /opt/velnor/deploy/oci/.env     # SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET
sudo ./setup-vm.sh
```

`SLACK_BOT_TOKEN` is the `xoxb-` value from OAuth & Permissions, `SLACK_SIGNING_SECRET`
is on Basic Information. Both belong to app `A0CGA6K20UE`. The bot already posts into
`#velnor-agent`; the signing secret is what lets it *receive*.

## 5. Confirm

```bash
curl https://<public-ip>.sslip.io/api/health
```

Once that answers, the base URL for the Slack endpoints is
`https://<public-ip>.sslip.io` and the manifest can carry
`/api/webhooks/slack` on it.

## Why sslip.io

Slack will not accept a plain-HTTP request URL, and a certificate needs a hostname.
`sslip.io` is public DNS that resolves `<anything>.<ip>.sslip.io` to that IP, so
Let's Encrypt can issue for it with no domain registration. The day you point a real
domain at the VM, change `VELNOR_HOST` and nothing else.

## Adding the other services later

`docker-compose.yml` is the natural home for them: each gets its own service with
`restart: unless-stopped`, and Caddy gets a matching block in `Caddyfile` for its
path or subdomain. Keep their ports off the host and let Caddy route, exactly as
Velnor does.

## Operating it

```bash
cd /opt/velnor/deploy/oci
sudo docker compose logs -f velnor     # what the agent is doing
sudo docker compose up -d --build      # deploy a new commit
sudo docker compose ps                 # health and uptime
```

State lives in the `velnor-data` volume at `/app/.data` and survives rebuilds.
`docker compose down -v` deletes it, so do not use `-v` casually.
