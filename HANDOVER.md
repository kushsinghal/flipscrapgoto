# Handover

## Verified (this session, local)

- Production build with `NITRO_PRESET=node-server`: passes. The default preset is Cloudflare and does not run under Node.
- Test suite (`bun test`): 65 pass, 0 fail.
- Startup: `scripts/start.mjs` exits with code 1 in production when `API_KEYS` (a key of 16+ characters), `UI_PASSWORD` (12+) or `SESSION_SECRET` (32+) is missing or too short.
- `/api/public/health` returns 200 with no Flipkart request.
- `/api/public/ready` returns 200 when keys are configured and reports `fetch_mode`. It returns 503 when they are not.
- `/api/public/product` returns 401 with no key, 401 when the key is in the URL query, and 400 `INVALID_URL` for a non-Flipkart URL with a valid key.
- `/api/public/debug` returns 404 by default (debug disabled; it does not reveal itself with 401).
- CORS: no `Access-Control-Allow-Origin` header for an unknown origin.
- Homepage password flow in headless Chromium: the password form appears after a lookup, a wrong password keeps it locked, the correct password unlocks it, and the session cookie `fk_ui_session` is HttpOnly and SameSite=Strict.
- Chromium launch smoke test (`playwright-core` 1.59.0, headless) passes after installing the OS libraries with `playwright-core install-deps chromium`.
- Secret scan: the API key, UI password and session secret do not appear in server logs, in a product response, or in the frontend bundle.
- Live extraction (HTTP mode, from this sandbox, one request): `/api/public/product` returned 200 with title, listed price 27990, MRP 41999, availability and seller data. Fields that could not be confirmed are marked with a reason in `field_status` and `errors`.

## Not verified

- Docker image build: Docker is not available in this sandbox. Run the commands in DEPLOY.md.
- `FETCH_MODE=browser` end-to-end extraction: only the Chromium launch was tested, not a full browser-mode product fetch.
- Live extraction on Render: only from this sandbox.
- Git commit and push: this workspace is not a git repository and has no GitHub remote configured, so nothing was committed or pushed.
- Stale-data guard for "verified deal" publishing: not built or tested in this session.
- Focused tests for offers, SuperCoins, redirect checks, blocking and cache: not added in this session.

## Offer audit findings

- Selling price, MRP, discount and "Buy at / lowest price" are separate fields, and each carries a provenance trace in `extraction_trace`.
- `price_with_offers` comes from Flipkart's own "lowest price" label. It is not our computed payable price.
- `effective_price_estimate` is `null` with reason `eligibility_unknown`. It is never estimated without evidence.
- SuperCoins usable and earned are `null` because the page did not print them. `advertised_full_back` is `false` unless "100% back" is literally printed.
- Known issue: the coupon list can include coupons for other product categories shown on the same page (for example "Storage Devices" and "Air fryer" coupons on a laptop page). These are raw text and are not applied to the price, but they are not filtered by product yet.
- Known issue: the exchange offer shows "Not available at this Pincode" next to a maximum value. The value is shown as text only and is not treated as available.
- `fetched_at` was added as an alias of `scraped_at` (same timestamp).

## Open items

- Add focused tests for offers, SuperCoins, redirects, blocking and cache.
- Add a stale-data check before any "verified deal" posting.
- Filter coupons and exchange values by availability for the product.
- Commit and push: needs the GitHub repository name, or a repository connection in this workspace.
