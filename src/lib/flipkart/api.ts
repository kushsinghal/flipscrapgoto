// Request handling for the public API, kept separate from route files so it can be tested.
import { ServerBusyError } from "./errors";
import { extractProductFromHtml } from "./extract";
import { DEFAULT_GUARD, sharedGuard, type GuardSettings } from "./guard";
import { isDisallowedUrl, isFlipkartProductUrl, normalizeProductUrl } from "./parse";
import {
  fetchProductPage,
  FlipkartBlockedError,
  FlipkartNotFoundError,
  type FetchedPage,
  type FetchMode,
  type ScraperSettings,
} from "./scraper";
import { corsHeaders, loadServerConfig, preflight, requireApiKey, withHeaders, type ServerConfig } from "./security";
import type { ErrorResponse, ProductResponse } from "./types";

export const API_NAME = "Flipkart Product Details API";
export const API_VERSION = "2.1.0";

export function apiInfo() {
  return {
    name: API_NAME,
    version: API_VERSION,
    description: "Accept a Flipkart product URL and return structured product data as JSON.",
    authentication: "Send your API key as `X-API-Key: <key>` or `Authorization: Bearer <key>`.",
    endpoints: {
      health: "GET /api/public/health",
      ready: "GET /api/public/ready",
      product: "GET /api/public/product?url=<flipkart_product_url>",
      debug: "GET /api/public/debug?url=<flipkart_product_url> (only when ENABLE_DEBUG_ENDPOINT=true)",
    },
  };
}

const truthy = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
const int = (v: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

/** Reads optional settings from the environment. Call inside a request handler. */
export function loadSettings(env: Record<string, string | undefined> = process.env): ScraperSettings {
  const production = loadServerConfig(env).production;
  const mode = (env["FETCH_MODE"] ?? "http").trim().toLowerCase();
  return {
    requestTimeoutSeconds: int(env["REQUEST_TIMEOUT_SECONDS"], 45, 5, 120),
    userAgent: env["USER_AGENT"] || null,
    // Page HTML is never returned in production.
    debugSaveHtml: !production && truthy(env["DEBUG_SAVE_HTML"]),
    fetchMode: (mode === "browser" ? "browser" : "http") as FetchMode,
  };
}

export function loadGuardSettings(env: Record<string, string | undefined> = process.env): GuardSettings {
  return {
    cacheTtlSeconds: int(env["CACHE_TTL_SECONDS"], DEFAULT_GUARD.cacheTtlSeconds, 0, 86_400),
    cacheMaxEntries: int(env["CACHE_MAX_ENTRIES"], DEFAULT_GUARD.cacheMaxEntries, 0, 5_000),
    maxConcurrent: int(env["MAX_CONCURRENT_SCRAPES"], DEFAULT_GUARD.maxConcurrent, 1, 4),
    maxQueued: int(env["MAX_QUEUED_SCRAPES"], DEFAULT_GUARD.maxQueued, 0, 50),
    blockCooldownSeconds: int(env["BLOCK_COOLDOWN_SECONDS"], DEFAULT_GUARD.blockCooldownSeconds, 1, 3600),
  };
}

function errorJson(status: number, error: string, detail: string, headers: Record<string, string> = {}): Response {
  const body: ErrorResponse = { status: "error", error, detail };
  return Response.json(body, { status, headers });
}

/** Short, single-line log text: never page HTML, headers or keys. */
function logText(e: unknown): string {
  return (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/\s+/g, " ").slice(0, 300);
}

/** Returns the error for an unacceptable `url`, or the URL when it is acceptable. */
export function validateProductUrl(url: string | null): { error: Response } | { url: string } {
  if (url === null) {
    // Same shape FastAPI returned for a missing required query parameter.
    return {
      error: Response.json(
        { detail: [{ type: "missing", loc: ["query", "url"], msg: "Field required", input: null }] },
        { status: 422 },
      ),
    };
  }
  if (url.length > 2048 || !isFlipkartProductUrl(url)) {
    return {
      error: errorJson(
        400,
        "INVALID_URL",
        "URL must be a Flipkart product page on flipkart.com (https://www.flipkart.com/…/p/itm…).",
      ),
    };
  }
  if (isDisallowedUrl(url)) {
    return { error: errorJson(400, "INVALID_URL", "URL points to a Flipkart path that robots.txt disallows for automated access.") };
  }
  return { url: url.trim() };
}

function validateUrlParam(request: Request) {
  return validateProductUrl(new URL(request.url).searchParams.get("url"));
}

type Scrape = (url: string, settings: ScraperSettings) => Promise<ProductResponse>;
type Fetch = (url: string, settings: ScraperSettings) => Promise<FetchedPage>;

function mapScrapeError(e: unknown, where: string): Response {
  if (e instanceof FlipkartNotFoundError) {
    return errorJson(404, "PRODUCT_NOT_FOUND", "The product page could not be found.");
  }
  if (e instanceof FlipkartBlockedError) {
    console.warn(`Flipkart blocked (${e.reason}):`, logText(e));
    const headers: Record<string, string> = e.retryAfterSeconds ? { "Retry-After": String(e.retryAfterSeconds) } : {};
    return errorJson(503, "FLIPKART_BLOCKED", e.message, headers);
  }
  if (e instanceof ServerBusyError) {
    return errorJson(429, "RATE_LIMITED", e.message, { "Retry-After": "5" });
  }
  console.error(`${where}:`, logText(e));
  return errorJson(500, "INTERNAL_ERROR", e instanceof Error ? e.message.slice(0, 300) : "Unexpected error.");
}

export async function handleProductRequest(
  request: Request,
  deps: { scrape?: Scrape; settings?: ScraperSettings; guard?: GuardSettings } = {},
): Promise<Response> {
  const v = validateUrlParam(request);
  if ("error" in v) return v.error;
  const settings = deps.settings ?? loadSettings();

  try {
    if (deps.scrape) return Response.json(await deps.scrape(v.url, settings));
    const { product, cached } = await sharedGuard.lookup(v.url, settings, deps.guard ?? loadGuardSettings());
    return Response.json(product, { headers: { "X-Cache": cached ? "HIT" : "MISS" } });
  } catch (e) {
    return mapScrapeError(e, "Internal error scraping product");
  }
}

/**
 * Debug view: product, extraction_trace and errors side by side. The fetched HTML is
 * included only when DEBUG_SAVE_HTML=true outside production.
 */
export async function handleDebugRequest(
  request: Request,
  deps: { fetchPage?: Fetch; settings?: ScraperSettings } = {},
): Promise<Response> {
  const v = validateUrlParam(request);
  if ("error" in v) return v.error;
  const url = v.url;

  const fetchPage = deps.fetchPage ?? fetchProductPage;
  const settings = deps.settings ?? loadSettings();

  try {
    sharedGuard.breaker.check();
    const page = await fetchPage(url, settings);
    const product = extractProductFromHtml(page.html, url);
    return Response.json({
      status: "ok",
      product,
      extraction_trace: product.extraction_trace,
      field_status: product.field_status,
      errors: product.errors,
      saved_html: settings.debugSaveHtml ? "inline" : null,
      ...(settings.debugSaveHtml ? { html: page.html } : {}),
    });
  } catch (e) {
    if (e instanceof FlipkartNotFoundError) {
      return errorJson(404, "PRODUCT_NOT_FOUND", "The product page could not be found.");
    }
    if (e instanceof FlipkartBlockedError) {
      return Response.json({ status: "blocked", product: null, extraction_trace: {}, errors: [e.message], saved_html: null });
    }
    return mapScrapeError(e, "Debug endpoint error");
  }
}

// ---------------------------------------------------------------------------
// Route entry points: CORS + API key, then the handlers above.
// ---------------------------------------------------------------------------
type Handler = (request: Request) => Promise<Response>;

async function protectedRoute(request: Request, handler: Handler, config: ServerConfig): Promise<Response> {
  const cors = corsHeaders(request, config);
  if (request.method === "OPTIONS") return preflight(request, config);
  const denied = await requireApiKey(request, config);
  if (denied) return withHeaders(denied, cors);
  return withHeaders(await handler(request), cors);
}

export function productRoute(request: Request, deps: { config?: ServerConfig; scrape?: Scrape } = {}) {
  const config = deps.config ?? loadServerConfig();
  return protectedRoute(request, (r) => handleProductRequest(r, deps.scrape ? { scrape: deps.scrape } : {}), config);
}

export async function debugRoute(request: Request, deps: { config?: ServerConfig; fetchPage?: Fetch } = {}) {
  const config = deps.config ?? loadServerConfig();
  if (!config.debugEnabled) return errorJson(404, "NOT_FOUND", "Not found.");
  return protectedRoute(request, (r) => handleDebugRequest(r, deps.fetchPage ? { fetchPage: deps.fetchPage } : {}), config);
}

export function healthResponse(): Response {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}

/** Readiness without contacting Flipkart: config, and in browser mode a local Chromium launch. */
export async function readyResponse(env: Record<string, string | undefined> = process.env): Promise<Response> {
  const config = loadServerConfig(env);
  const settings = loadSettings(env);
  const checks: Record<string, string | number | boolean> = {
    fetch_mode: settings.fetchMode ?? "http",
    api_keys_configured: config.apiKeys.length > 0,
    flipkart_cooldown_seconds: sharedGuard.breaker.remainingSeconds(),
    cached_products: sharedGuard.cache.size,
  };
  let ready = config.apiKeys.length > 0 || config.allowUnauthenticated;
  if (settings.fetchMode === "browser") {
    try {
      const { browserSelfTest } = await import("./browser");
      checks["browser"] = (await browserSelfTest()) === "chromium-ok" ? "ok" : "unexpected";
      if (checks["browser"] !== "ok") ready = false;
    } catch (e) {
      checks["browser"] = "unavailable";
      console.error("Readiness: browser check failed:", logText(e));
      ready = false;
    }
  }
  return Response.json(
    { status: ready ? "ready" : "not_ready", checks },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

// ---------------------------------------------------------------------------
// Web page lookup (server function): same guard, no API key in the browser.
// ---------------------------------------------------------------------------
export type WebLookupResult =
  | { ok: true; product: ProductResponse }
  | { ok: false; error: string; detail: string | null };

export async function webLookup(rawUrl: string): Promise<WebLookupResult> {
  const config = loadServerConfig();
  if (!config.webLookupEnabled) {
    return { ok: false, error: "NOT_FOUND", detail: "Lookups from this page are turned off. Use the API with an API key." };
  }
  const v = validateProductUrl(rawUrl);
  if ("error" in v) {
    const body = (await v.error.json()) as Partial<ErrorResponse>;
    return { ok: false, error: body.error ?? "INVALID_URL", detail: body.detail ?? null };
  }
  try {
    const { product } = await sharedGuard.lookup(normalizeProductUrl(v.url), loadSettings(), loadGuardSettings());
    return { ok: true, product };
  } catch (e) {
    const body = (await mapScrapeError(e, "Web lookup error").json()) as ErrorResponse;
    return { ok: false, error: body.error, detail: body.detail };
  }
}
