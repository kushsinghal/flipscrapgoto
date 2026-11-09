// Fetches one user-supplied Flipkart product page and hands the HTML to extract.ts.
//
// Two fetch modes (FETCH_MODE): "http" (default; plain fetch, works on the edge) and
// "browser" (headless Chromium via browser.ts; Node/Docker builds only). Either way,
// redirects are checked hop by hop so the scraper never lands off Flipkart or on a path
// robots.txt disallows, and block pages are reported, never retried or bypassed.
import { FlipkartBlockedError, FlipkartNotFoundError, FlipkartScraperError } from "./errors";
import { detectBlockReason, extractProductFromHtml } from "./extract";
import { isAllowedFlipkartPageUrl, isDisallowedUrl, normalizeProductUrl } from "./parse";
import type { ProductResponse } from "./types";

export { FlipkartBlockedError, FlipkartNotFoundError, FlipkartScraperError };
export { extractProductFromHtml, SELECTORS } from "./extract";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const MAX_REDIRECTS = 5;

export type FetchMode = "http" | "browser";

export interface ScraperSettings {
  requestTimeoutSeconds: number;
  userAgent: string | null;
  /** When true, the debug endpoint returns the fetched HTML (nothing is written to disk). */
  debugSaveHtml?: boolean;
  fetchMode?: FetchMode;
}

export interface FetchedPage {
  html: string;
  finalUrl: string;
  status?: number;
}

export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(Math.round(secs), 3600);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.min(Math.round((at - Date.now()) / 1000), 3600)) : null;
}

/** Validates a redirect target; throws instead of following anything unsafe. */
export function checkRedirectTarget(location: string, from: string): string {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new FlipkartBlockedError("Flipkart sent an unreadable redirect; not following.", { reason: "disallowed_redirect" });
  }
  if (!isAllowedFlipkartPageUrl(next)) {
    throw new FlipkartBlockedError("Flipkart redirected away from flipkart.com; not following.", {
      reason: "disallowed_redirect",
    });
  }
  if (/\/(?:account\/)?login\b/i.test(next.pathname)) {
    throw new FlipkartBlockedError("Flipkart redirected to a login page; not following.", { reason: "login_wall" });
  }
  if (isDisallowedUrl(next.toString())) {
    throw new FlipkartBlockedError(`Flipkart redirected to a disallowed path (${next.pathname}); not following.`, {
      reason: "disallowed_redirect",
    });
  }
  next.protocol = "https:";
  next.port = "";
  return next.toString();
}

/** Maps a final HTTP status + body to a not-found / blocked error, or returns nothing. */
export function assertUsablePage(status: number, html: string, retryAfter: number | null) {
  if (status === 404 || status === 410) throw new FlipkartNotFoundError("Product page returned 404.");
  if (status === 429) {
    throw new FlipkartBlockedError("Flipkart responded with HTTP 429 (rate limited). Not retrying.", {
      reason: "rate_limited",
      retryAfterSeconds: retryAfter,
    });
  }
  if (status === 403 || status === 503 || status === 529) {
    throw new FlipkartBlockedError(`Flipkart responded with HTTP ${status} (possible block). Not retrying.`, {
      reason: status === 403 ? "access_denied" : "rate_limited",
      retryAfterSeconds: retryAfter,
    });
  }
  if (status >= 500) throw new FlipkartScraperError(`Flipkart responded with HTTP ${status}.`);
  const reason = detectBlockReason(html);
  if (reason) {
    throw new FlipkartBlockedError(
      reason === "captcha"
        ? "Flipkart is showing a CAPTCHA page. Not bypassing it."
        : reason === "rate_limited"
          ? "Flipkart is showing a rate-limit page. Not retrying."
          : "Flipkart is showing an access-denied page. Not bypassing it.",
      { reason, retryAfterSeconds: retryAfter },
    );
  }
}

async function fetchOverHttp(url: string, settings: ScraperSettings): Promise<FetchedPage> {
  const signal = AbortSignal.timeout(settings.requestTimeoutSeconds * 1000);
  let current = normalizeProductUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let resp: Response;
    try {
      resp = await fetch(current, {
        redirect: "manual",
        headers: {
          "User-Agent": settings.userAgent || DEFAULT_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-IN,en;q=0.9",
        },
        signal,
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new FlipkartBlockedError(`Timeout loading page after ${settings.requestTimeoutSeconds}s.`, { reason: "timeout" });
      }
      throw new FlipkartBlockedError("Could not reach Flipkart.", { reason: "network" });
    }

    const location = resp.headers.get("location");
    if (resp.status >= 300 && resp.status < 400) {
      if (!location) throw new FlipkartScraperError(`Flipkart sent HTTP ${resp.status} without a redirect target.`);
      await resp.body?.cancel().catch(() => {});
      current = checkRedirectTarget(location, current);
      continue;
    }

    const html = await resp.text();
    assertUsablePage(resp.status, html, parseRetryAfter(resp.headers.get("retry-after")));
    return { html, finalUrl: current, status: resp.status };
  }
  throw new FlipkartBlockedError("Too many redirects from Flipkart.", { reason: "disallowed_redirect" });
}

export async function fetchProductPage(url: string, settings: ScraperSettings): Promise<FetchedPage> {
  if (settings.fetchMode === "browser") {
    const { fetchWithBrowser } = await import("./browser");
    return fetchWithBrowser(url, settings);
  }
  return fetchOverHttp(url, settings);
}

export async function scrapeProduct(url: string, settings: ScraperSettings): Promise<ProductResponse> {
  const page = await fetchProductPage(url, settings);
  return extractProductFromHtml(page.html, url);
}
