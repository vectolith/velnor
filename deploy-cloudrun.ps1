param(
  [string]$ProjectId = $env:GOOGLE_CLOUD_PROJECT,
  [string]$Region = "us-central1",
  [string]$ServiceName = "velnor-agent",
  [string]$DataVolume = ""
)

$ErrorActionPreference = "Stop"

if (-not $ProjectId) {
  Write-Host "Usage: .\deploy-cloudrun.ps1 -ProjectId <your-gcp-project-id> [-Region us-central1] [-DataVolume <gcs-bucket>]" -ForegroundColor Yellow
  exit 1
}

# Velnor fails closed. A deploy missing a secret produces a service that answers
# 503 on every state-touching route, so check the environment first.
node scripts/preflight-deploy.mjs
if ($LASTEXITCODE -ne 0) {
  Write-Host "Preflight failed: export the missing variables, then run this again." -ForegroundColor Red
  exit 1
}

$envPairs = @(
  "NODE_ENV=production",
  "VELNOR_SHARED_SECRET=$env:VELNOR_SHARED_SECRET",
  "VELNOR_SECRET_KEY=$env:VELNOR_SECRET_KEY",
  "CRON_SECRET=$env:CRON_SECRET",
  "VELNOR_DATA_DIR=/app/.data"
)

foreach ($optional in @("TWILIO_AUTH_TOKEN", "SLACK_SIGNING_SECRET", "SENDBLUE_WEBHOOK_SECRET", "LOOPMESSAGE_WEBHOOK_SECRET", "VELNOR_EMAIL_ALLOWLIST", "GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "BLUD_INTERNAL_RPC_URL")) {
  $value = [Environment]::GetEnvironmentVariable($optional)
  if ($value) { $envPairs += "$optional=$value" }
}

$arguments = @(
  "run", "deploy", $ServiceName,
  "--source", ".",
  "--project", $ProjectId,
  "--region", $Region,
  "--allow-unauthenticated",
  "--port", "8080",
  "--memory", "1Gi",
  "--cpu", "1",
  "--min-instances", "1",
  "--max-instances", "4",
  "--concurrency", "40",
  "--set-env-vars", ($envPairs -join ",")
)

# Without a mounted volume the container filesystem is ephemeral and every
# chat, reminder and sealed credential disappears on the next revision.
if ($DataVolume) {
  $arguments += @("--add-volume", "name=data,type=cloud-storage,bucket=$DataVolume")
  $arguments += @("--add-volume-mount", "volume=data,mount-path=/app/.data")
}

Write-Host "Deploying Velnor to Cloud Run ($ProjectId / $Region)..." -ForegroundColor Cyan
& gcloud @arguments
exit $LASTEXITCODE
