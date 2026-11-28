# Velnor IDE

Velnor is a single-file-workspace, VS Code-class code editor that runs in the browser.
The root path redirects to `/ide`; the IDE can be deployed independently to Cloudflare Workers.

## Product direction

VELNOR is being developed as an evidence-driven engineering IDE: intent-to-implementation planning, preflight impact analysis, durable execution, project memory, bounded repair and provider independence. See [the product thesis](docs/PRODUCT-THESIS.md) for the proposed differentiating architecture. This direction is a roadmap, not a claim that all capabilities are implemented.


## Hosted preview (zero-cost option)

A Render free-tier Docker blueprint is included in `render.yaml`. See [deployment instructions](docs/DEPLOY-FREE.md) or [deploy using Render](https://render.com/deploy?repo=https://github.com/vectolith/velnor). Free services may sleep and are intended for preview use.

## What it does

- File tree for a local workspace with per-file language detection
- Monaco editor pane with tabs, dirty state and syntax highlighting
- Live HTML/CSS/JS preview with a console
- Command palette (Cmd/Ctrl+K) for files, actions and navigation
- Assistant panel that talks to any OpenAI-compatible endpoint with your own key
- Workspace persistence in the browser plus JSON export

## Run it

```bash
npm install
npm run dev      # http://localhost:3000/ide
```

Production:

```bash
npm run build
npm run start    # or: docker build -t velnor . && docker run -p 8080:8080 velnor
```

## Configuration

Everything is optional and read from the environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VELNOR_AI_API_KEY` | unset | Model key used when the browser does not paste one |
| `VELNOR_AI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible chat-completions base URL |
| `VELNOR_AI_MODEL` | `gpt-4o-mini` | Model name sent to the endpoint |

## Security

- Workspace content is stored in browser local storage. Provider tokens are kept in memory for the current tab session and are not persisted.
- Configure HTTPS, secrets management, edge rate limits and trustworthy proxy IP handling in production. Proxy IP headers are ignored by the assistant rate limiter unless `VELNOR_TRUST_PROXY_HEADERS=true`; only enable it when ingress strips client-supplied headers and injects normalized identity.
- The assistant endpoint's in-memory rate limit is process-local and is not a distributed abuse control.
- The server-configured provider base URL should be trusted and controlled.
- Preview code runs in a sandboxed iframe.

Read [SECURITY.md](SECURITY.md) for vulnerability reporting and [the security readiness guide](docs/SECURITY-READINESS.md) for deployment and testing limits.

## Verify

```bash
npm test          # node:test unit suite
npm run typecheck # tsc --noEmit
npm run build     # next build
npm run verify    # checks a running server on :3000
```

## Layout

```
src/app/ide/        IdeShell, EditorPane, FileTree, PreviewPane, AiPanel, CommandPalette
src/app/api/ide/    chat-completions proxy used by the assistant panel
src/lib/ide/        workspace model: files, language detection, preview document builder
tests/              unit tests for the workspace model
scripts/verify-ide.mjs   production smoke check
docs/SECURITY-READINESS.md security review and deployment checklist
```

Model training notebooks and run artifacts live in Models-by-vectolith, not here.

## Cloudflare Workers deployment

The separate IDE Worker is named `velnor` and uses **https://velnor.vectolith.workers.dev**. It does not replace the headless service.

From a Node.js 26 environment:

```bash
npm ci
npm run cf:build
npm run cf:preview
# deploy only after credentials are configured:
npm run cf:deploy
```

The GitHub Actions deployment is manual (`workflow_dispatch`). Configure repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` with Workers Scripts write permissions before running it. CI validates the Next.js production server and the OpenNext/Wrangler runtime before deployment.
