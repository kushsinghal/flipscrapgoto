# Project memory

## Product intent & audience

- Flipkart product data extraction service with a web UI and protected API
- Backend: Nitro server (builds to Node target for Render deployment)
- Frontend: Vite + React single-page app served as homepage
- Audience: end users accessing a password-protected UI; API consumers using API keys

## Brand personality & voice

- No brand voice guidance inferred yet; UI is functional/utilitarian (password prompt, data display)

## Visual design & UX direction

- Homepage presents an access password prompt before calling the API
- No design system, color palette, or typography preferences inferred yet
- Responsive behavior and accessibility not yet addressed

## Decisions, constraints & rationale

- Nitro preset switched from Cloudflare default to `node-server` so the server runs on Render; `NITRO_PRESET` env var controls the target
- Dockerfile build stage sets `NITRO_PRESET` explicitly
- API endpoints (`/product`, `/debug`) require API key via header; query-string key is rejected for security
- `/debug` endpoint disabled by default
- `/health` and `/readiness` return 200 without contacting Flipkart or requiring auth
- CORS configuration in place
- Session-based UI auth using `SESSION_SECRET`; `UI_PASSWORD` gates homepage access
- Env vars required at deploy time: `API_KEYS`, `UI_PASSWORD`, `SESSION_SECRET`
- `AGENTS.md` currently forbids headless browser usage — unresolved conflict with Chromium-based scraping approach
- 65 tests covering API keys, CORS, readiness, and core functionality
- `DEPLOY.md` and `HANDOVER.md` created as deliverables

## Open questions & assumptions

- Live Flipkart extraction not verified — offers and SuperCoins parsing not re-audited
- Docker image not built/tested in the current environment
- Chromium browser mode unverified in deployment
- Password prompt UX not tested in a real browser
- Nothing committed or pushed; user must set env vars on Render
- `AGENTS.md` needs updating to permit headless browser if scraping requires it