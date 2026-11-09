<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Project rules

- Flipkart scraping lives in `src/lib/flipkart/` (text helpers/validation in `parse.ts`, HTML extraction in `extract.ts`, fetch + redirect checks in `scraper.ts`, HTTP contract in `api.ts`); route files only delegate. Why: keeps the API contract and parsing unit-testable without network.
- Extraction reads only visible text of the main product section (after the `<h1>`, skipping hidden layers and other products' `/p/` links) and records each field's source in `extraction_trace`; selector changes are checked against saved real pages in `src/lib/flipkart/__fixtures__/`. Why: page-wide regexes picked up ad-carousel prices and header links as data.
- Never request, follow redirects to, or report text pointing at paths Flipkart's robots.txt disallows (`isDisallowedUrl` in `parse.ts`). Why: ethical-use rules of the original project.
- Direct HTTP fetch is the primary extraction method. Playwright (`playwright-core`, Chromium) is allowed ONLY as an optional, explicitly enabled (`FETCH_MODE=browser`), low-volume fallback: one page at a time, never the default path, never used for CAPTCHA bypass, stealth or fingerprint evasion, or IP/proxy rotation. The browser runs only in the Node/Docker target. Parsing uses `node-html-parser`; do not add another Node-only HTML library. Why: the original project was edge-only; the browser fallback was added for accuracy on pages that need client rendering.
- Public API endpoints live under `src/routes/api/public/` and keep the original snake_case JSON shape and error codes (400 INVALID_URL, 404 PRODUCT_NOT_FOUND, 503 FLIPKART_BLOCKED, 500 INTERNAL_ERROR). Why: existing callers of the migrated FastAPI service depend on them.
- CAPTCHA, login walls and rate limits are reported as FLIPKART_BLOCKED, never bypassed. Why: the original project's ethical-use rules.
