$ErrorActionPreference = "Stop"

Write-Error @"
Cloud Run deployment is disabled for this release. Velnor stores live state in
single-writer SQLite/JSON files, while Cloud Run's default writable filesystem
is ephemeral and does not provide the locking guarantees this store requires.
The production Docker Compose deployment with its named persistent volume is
defined in deploy/oci/docker-compose.yml.
"@
exit 1
