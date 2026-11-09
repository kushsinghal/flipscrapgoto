// Headless Chromium fetch for the Node/Docker (Render) build: FETCH_MODE=browser.
//
// - playwright-core is loaded at runtime by name, so it is never bundled into the edge
//   worker (which has no browsers); there FETCH_MODE=browser fails with a clear error.
// - One browser process, one page at a time (guard.ts also caps lookups at 1 in this mode).
// - Every request is checked: documents only on exact Flipkart hosts, each redirect hop is
//   validated before it is followed, sub-resources only from Flipkart/Flixcart over https,
//   never robots.txt-disallowed paths; images, media and fonts are not downloaded.
// - Nothing is clicked or typed; CAPTCHA / block pages are reported, never bypassed.
// - The browser closes after BROWSER_IDLE_SECONDS without use and on SIGTERM/SIGINT.
import { FlipkartBlockedError, FlipkartScraperError } from "./errors";
import { isAllowedFlipkartPageUrl, isAllowedResourceUrl, isDisallowedUrl, normalizeProductUrl } from "./parse";
import {
  assertUsablePage,
  checkRedirectTarget,
  DEFAULT_USER_AGENT,
  MAX_REDIRECTS,
  parseRetryAfter,
  type FetchedPage,
  type ScraperSettings,
} from "./scraper";

// Minimal structural types so this file type-checks without importing playwright types.
interface PwRoute {
  request(): PwRequest;
  abort(code?: string): Promise<void>;
  continue(): Promise<void>;
  fetch(opts: { maxRedirects: number; timeout: number }): Promise<PwApiResponse>;
  fulfill(opts: { response: PwApiResponse }): Promise<void>;
}
interface PwRequest {
  url(): string;
  resourceType(): string;
  isNavigationRequest(): boolean;
  frame(): unknown;
}
interface PwApiResponse {
  status(): number;
  headers(): Record<string, string>;
}
interface PwResponse {
  status(): number;
  headers(): Record<string, string>;
}
interface PwPage {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<PwResponse | null>;
  waitForSelector(sel: string, opts: { timeout: number }): Promise<unknown>;
  content(): Promise<string>;
  url(): string;
  mainFrame(): unknown;
  setDefaultTimeout(ms: number): void;
  setContent(html: string): Promise<void>;
  textContent(sel: string): Promise<string | null>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  route(pattern: string, handler: (route: PwRoute) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
  on(event: "disconnected", cb: () => void): void;
  isConnected(): boolean;
}
interface PwModule {
  chromium: { launch(opts: Record<string, unknown>): Promise<PwBrowser> };
}

const PLAYWRIGHT_MODULE = "playwright-core";
const SKIPPED_RESOURCE_TYPES = new Set(["image", "media", "font", "imageset", "texttrack", "manifest"]);

let browserPromise: Promise<PwBrowser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let shutdownHooked = false;
let busy = false;

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function loadPlaywright(): Promise<PwModule> {
  try {
    return (await import(/* @vite-ignore */ PLAYWRIGHT_MODULE)) as PwModule;
  } catch {
    throw new FlipkartScraperError(
      "Browser mode is unavailable in this runtime (playwright-core / Chromium not installed). Use FETCH_MODE=http or the Docker build.",
    );
  }
}

function launchOptions(): Record<string, unknown> {
  return {
    headless: true,
    // Chromium's own sandbox needs kernel features most containers (Render included) lack.
    chromiumSandbox: (process.env["BROWSER_SANDBOX"] ?? "").toLowerCase() === "true",
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--mute-audio"],
    timeout: 30_000,
  };
}

function hookShutdown() {
  if (shutdownHooked || typeof process === "undefined" || typeof process.once !== "function") return;
  shutdownHooked = true;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void closeBrowser();
    });
  }
}

async function getBrowser(): Promise<PwBrowser> {
  if (!browserPromise) {
    const pw = await loadPlaywright();
    hookShutdown();
    browserPromise = pw.chromium.launch(launchOptions()).then((b) => {
      b.on("disconnected", () => {
        browserPromise = null;
      });
      return b;
    });
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!busy) void closeBrowser();
  }, envInt("BROWSER_IDLE_SECONDS", 120) * 1000);
  (idleTimer as { unref?: () => void }).unref?.();
}

/** Closes the shared browser (idle timeout, shutdown, tests). Safe to call repeatedly. */
export async function closeBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const p = browserPromise;
  browserPromise = null;
  if (!p) return;
  try {
    const b = await p;
    await b.close();
  } catch {
    /* already gone */
  }
}

/** Launches Chromium and renders a local page (no network). Used by /ready and the smoke test. */
export async function browserSelfTest(): Promise<string> {
  const browser = await getBrowser();
  const context = await browser.newContext({ javaScriptEnabled: true });
  try {
    const page = await context.newPage();
    await page.setContent("<h1>chromium-ok</h1>");
    return (await page.textContent("h1")) ?? "";
  } finally {
    await context.close().catch(() => {});
    scheduleIdleClose();
  }
}

export interface BrowserFetchOptions {
  /** Test hook: which document URLs count as Flipkart pages. */
  allowPage?: (u: URL) => boolean;
  /** Test hook: which sub-resource URLs may load. */
  allowResource?: (u: URL) => boolean;
}

export async function fetchWithBrowser(
  url: string,
  settings: ScraperSettings,
  opts: BrowserFetchOptions = {},
): Promise<FetchedPage> {
  const allowPage = opts.allowPage ?? ((u: URL) => isAllowedFlipkartPageUrl(u));
  const allowResource = opts.allowResource ?? ((u: URL) => isAllowedResourceUrl(u));
  const timeoutMs = settings.requestTimeoutSeconds * 1000;
  const start = opts.allowPage ? url : normalizeProductUrl(url);

  const browser = await getBrowser();
  busy = true;
  const context = await browser.newContext({
    userAgent: settings.userAgent || DEFAULT_USER_AGENT,
    locale: "en-IN",
    serviceWorkers: "block",
    acceptDownloads: false,
    viewport: { width: 412, height: 915 },
  });
  let violation: FlipkartBlockedError | null = null;
  let hops = 0;
  const timer = setTimeout(() => void context.close().catch(() => {}), timeoutMs + 2000);

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await context.route("**/*", async (route) => {
      const req = route.request();
      const raw = req.url();
      if (raw.startsWith("data:") || raw.startsWith("blob:")) return route.continue();
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        return route.abort("blockedbyclient");
      }
      const isDoc = req.resourceType() === "document";
      if (isDoc && req.frame() !== page.mainFrame()) return route.abort("blockedbyclient"); // no iframes
      if (!isDoc && SKIPPED_RESOURCE_TYPES.has(req.resourceType())) return route.abort("blockedbyclient");
      if (isDisallowedUrl(raw) && !opts.allowPage) return route.abort("blockedbyclient");
      if (!isDoc) return allowResource(u) ? route.continue() : route.abort("blockedbyclient");

      if (!allowPage(u)) {
        violation ??= new FlipkartBlockedError("Navigation left flipkart.com; stopped.", { reason: "disallowed_redirect" });
        return route.abort("blockedbyclient");
      }
      // Fetch the document ourselves without following redirects, so every hop is
      // validated *before* the browser requests it.
      const resp = await route.fetch({ maxRedirects: 0, timeout: timeoutMs });
      const status = resp.status();
      const location = resp.headers()["location"];
      if (status >= 300 && status < 400 && location) {
        hops++;
        try {
          if (hops > MAX_REDIRECTS) {
            throw new FlipkartBlockedError("Too many redirects from Flipkart.", { reason: "disallowed_redirect" });
          }
          if (opts.allowPage) {
            if (!allowPage(new URL(location, raw))) {
              throw new FlipkartBlockedError("Flipkart redirected away from flipkart.com; not following.", {
                reason: "disallowed_redirect",
              });
            }
          } else {
            checkRedirectTarget(location, raw);
          }
        } catch (e) {
          violation ??= e as FlipkartBlockedError;
          return route.abort("blockedbyclient");
        }
      }
      return route.fulfill({ response: resp });
    });

    let response: PwResponse | null = null;
    try {
      response = await page.goto(start, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch (e) {
      if (violation) throw violation;
      const msg = (e as Error).message ?? "";
      if (/timeout/i.test(msg)) {
        throw new FlipkartBlockedError(`Timeout loading page after ${settings.requestTimeoutSeconds}s.`, { reason: "timeout" });
      }
      throw new FlipkartBlockedError("Could not load the Flipkart page in the browser.", { reason: "network" });
    }
    if (violation) throw violation;

    // Let client rendering settle a little; never click or scroll.
    await page.waitForSelector("h1", { timeout: Math.min(8000, timeoutMs) }).catch(() => {});
    const html = await page.content();
    const finalUrl = page.url();
    if (!allowPage(new URL(finalUrl))) {
      throw new FlipkartBlockedError("Page ended up outside flipkart.com; discarded.", { reason: "disallowed_redirect" });
    }
    const status = response?.status() ?? 200;
    assertUsablePage(status, html, parseRetryAfter(response?.headers()["retry-after"] ?? null));
    return { html, finalUrl, status };
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {});
    busy = false;
    scheduleIdleClose();
  }
}
