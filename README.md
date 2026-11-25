# Velnor IDE

Velnor is a single-file-workspace, VS Code-class code editor that runs in the browser.
The root path redirects to `/ide`; there is no messaging, chat-agent, or Cloudflare
deployment surface in this repository anymore.

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
| `VELNOR_AI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible chat-completions base URL |
| `VELNOR_AI_MODEL` | `gpt-4o-mini` | Model name sent to the endpoint |

## Verify

```bash
npm test          # node:test unit suite
npm run typecheck # tsc --noEmit
npm run build     # next build
npm run verify    # boots nothing itself: checks a running server on :3000
```

## Layout

```
src/app/ide/        IdeShell, EditorPane, FileTree, PreviewPane, AiPanel, CommandPalette
src/app/api/ide/    chat-completions proxy used by the assistant panel
src/lib/ide/        workspace model: files, language detection, preview document builder
tests/              unit tests for the workspace model
scripts/verify-ide.mjs   production smoke check
```

Model training notebooks and run artifacts live in Models-by-vectolith, not here.


## Cloudflare Workers deployment

This repository can deploy the browser IDE separately from the existing Velnor headless service. The Worker name is `velnor-ide` and its URL is `https://velnor-ide.<account-subdomain>.workers.dev`.

Deployment uses the OpenNext Cloudflare adapter and Wrangler. From a Node.js 22 environment:

```bash
npm install
npm run cf:build
npm run cf:preview
# deploy when credentials are configured:
npm run cf:deploy
```

For GitHub Actions deployment, configure repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token should be scoped to the account with Workers Scripts write permissions. The deployment workflow is triggered by main-branch changes to application/deployment files or manually.
