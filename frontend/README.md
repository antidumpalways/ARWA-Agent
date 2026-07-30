# ARWA — Frontend (static demo UI)

This directory contains the single-file static dashboard for the ARWA
submission to the Casper Agentic Buildathon 2026 Final Round.

## What's here

- `index.html` — full landing page + embedded dashboard (Tailwind CDN,
  vanilla JS, dark theme, OG metadata).
- `vercel.json` — minimal config: security headers, clean URLs.

## Why a separate frontend

The 4-service stack (Backend :4000, MCP :3001, x402 :4001, Frontend :3000)
is intentionally not deployed to the cloud. The agent private key and
the CSPR.cloud facilitator access stay on the build machine. This
folder is the only piece we ship as a static asset so judges can see
the live UI and the deployment trade-off banner, and follow the
embedded links to the YouTube demo and the on-chain proofs.

## Deploy

### Option A — Vercel web (recommended, 1 minute)

1. Open https://vercel.com/new
2. Sign in with GitHub
3. Import `antidumpalways/ARWA-Agent`
4. **Root Directory**: set to `frontend`
5. **Framework Preset**: "Other"
6. **Build Command**: leave empty
7. **Output Directory**: leave empty (or `.`)
8. Click **Deploy**
9. After ~30 seconds the site is live at
   `https://arwa-agent.vercel.app` (or similar)
10. The `?dashboard=1` URL reveals the embedded dashboard with the
    deployment banner explaining the trade-off.

### Option B — Vercel CLI

```bash
cd frontend
npx vercel
# follow prompts
```

### Option C — Any static host

`index.html` is a self-contained file. It can be served by GitHub Pages,
Netlify, Cloudflare Pages, or any HTTP server. No build step. No
environment variables required.

## Dashboard query params

- `?dashboard=1` — opens the embedded dashboard (instead of the landing
  page). The dashboard will show the deployment banner if the backend
  is not reachable, with links to the YouTube demo and the on-chain
  proofs.
- `?api=https://your-backend.example.com` — overrides the API base URL.
  Useful if you deploy the backend separately and want the static
  frontend to talk to it.
- `?noSSE=1` — disables the EventSource stream (avoids noisy errors
  when the backend SSE endpoint is not available).
- `?noPoll=1` — disables the 5-second health polling.
