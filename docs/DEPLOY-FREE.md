# Zero-cost hosted preview

VELNOR uses a Next.js standalone server and Docker image. This blueprint targets Render's free web-service tier and is intended for personal preview/testing, not production reliability.

## Deploy

1. Open https://render.com/deploy?repo=https://github.com/vectolith/velnor (or Render dashboard).
2. Connect the repository and select the `render.yaml` Blueprint.
3. Review the service settings and deploy.
4. When deployment finishes, open the generated `*.onrender.com/ide` URL.

The blueprint uses the Dockerfile, checks `/ide`, and auto-deploys from `main`.

## Free-tier caveats

- Free web services may sleep when idle and take time to wake.
- Free services are not intended for production reliability and may have limited resources.
- VELNOR workspace and checkpoints currently live in the browser, not server disk.
- Do not enter secrets or sensitive project data in a public hosted instance. Review [SECURITY.md](../SECURITY.md) and [security readiness](SECURITY-READINESS.md).
- Provider credentials are stored in local browser storage by the current app; this is not a secure credential vault.

