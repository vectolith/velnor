param(
  [string]$ProjectId = $env:GOOGLE_CLOUD_PROJECT,
  [string]$Region = "us-central1",
  [string]$ServiceName = "olli-assistant"
)

if (-not $ProjectId) {
  Write-Host "Usage: .\deploy-cloudrun.ps1 -ProjectId <your-gcp-project-id> [-Region us-central1]" -ForegroundColor Yellow
  exit 1
}

Write-Host "Deploying Olli to Google Cloud Run ($ProjectId / $Region)..." -ForegroundColor Cyan
gcloud run deploy $ServiceName `
  --source . `
  --project $ProjectId `
  --region $Region `
  --allow-unauthenticated `
  --port 8080
