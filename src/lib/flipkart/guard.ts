// Protections around every live lookup: a bounded result cache, one shared request per
// URL, a concurrency limit with a short queue, and a cooldown after Flipkart blocks us.
// State lives per server process (per isolate on the edge).
import { FlipkartBlockedError, ServerBusyError } from "./errors";
import { productCacheKey } from "./parse";
import { scrapeProduct, type ScraperSettings } from "./scraper";
import type { ProductResponse } from "./types";

export interface GuardSettings {
  cacheTtlSeconds: number;
  cacheMaxEntries: number;
  maxConcurrent: number;
  maxQueued: number;
  blockCooldownSeconds: number;
}

export const DEFAULT_GUARD: GuardSettings = {
  cacheTtlSeconds: 600,
  cacheMaxEntries: 200,
  maxConcurrent: 1,
  maxQueued: 4,
  blockCooldownSeconds: 300,
};

// ---------------------------------------------------------------------------
// Bounded TTL cache (least recently used entry is evicted first)
// ---------------------------------------------------------------------------
export class TtlCache<V> {
  private map = new Map<string, { value: V; expires: number }>();
  constructor(private now: () => number = Date.now) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key: string, value: V, ttlSeconds: number, maxEntries: number) {
    if (ttlSeconds <= 0 || maxEntries <= 0) return;
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + ttlSeconds * 1000 });
    while (this.map.size > maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  get size() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------
// Concurrency limiter: a finished job hands its slot straight to the next waiter.
// ---------------------------------------------------------------------------
export class Limiter {
  private active = 0;
  private queue: Array<() => void> = [];
  async run<T>(max: number, maxQueued: number, fn: () => Promise<T>): Promise<T> {
    if (this.active >= Math.max(1, max)) {
      if (this.queue.length >= maxQueued) {
        throw new ServerBusyError("Too many lookups are already waiting. Try again in a few seconds.");
      }
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
  get stats() {
    return { active: this.active, queued: this.queue.length };
  }
}

// ---------------------------------------------------------------------------
// Cooldown after a block: no request reaches Flipkart until it expires.
// ---------------------------------------------------------------------------
export class BlockBreaker {
  private until = 0;
  private reason: string | null = null;
  constructor(private now: () => number = Date.now) {}
  remainingSeconds(): number {
    return Math.max(0, Math.ceil((this.until - this.now()) / 1000));
  }
  trip(seconds: number, reason: string) {
    const s = Math.min(Math.max(seconds, 1), 3600);
    this.until = Math.max(this.until, this.now() + s * 1000);
    this.reason = reason;
  }
  check() {
    const left = this.remainingSeconds();
    if (left > 0) {
      throw new FlipkartBlockedError(
        `Flipkart blocked a recent request (${this.reason ?? "block"}). Pausing lookups for ${left}s instead of retrying.`,
        { reason: "cooldown", retryAfterSeconds: left },
      );
    }
  }
  reset() {
    this.until = 0;
    this.reason = null;
  }
}

const TRIPPING_REASONS = new Set(["rate_limited", "captcha", "access_denied", "login_wall"]);

type Scrape = (url: string, settings: ScraperSettings) => Promise<ProductResponse>;

export function createGuard(scrape: Scrape = scrapeProduct, now: () => number = Date.now) {
  const cache = new TtlCache<ProductResponse>(now);
  const limiter = new Limiter();
  const breaker = new BlockBreaker(now);
  const inflight = new Map<string, Promise<ProductResponse>>();

  async function lookup(
    url: string,
    settings: ScraperSettings,
    guard: GuardSettings = DEFAULT_GUARD,
  ): Promise<{ product: ProductResponse; cached: boolean }> {
    const key = productCacheKey(url);
    const hit = cache.get(key);
    if (hit) return { product: { ...hit, product_url: url }, cached: true };

    const pending = inflight.get(key);
    if (pending) return { product: { ...(await pending), product_url: url }, cached: true };

    breaker.check();
    // Browser mode is always limited to one page at a time.
    const max = settings.fetchMode === "browser" ? 1 : guard.maxConcurrent;
    const job = limiter.run(max, guard.maxQueued, async () => {
      breaker.check(); // a block may have happened while this lookup waited
      try {
        return await scrape(url, settings);
      } catch (e) {
        if (e instanceof FlipkartBlockedError && TRIPPING_REASONS.has(e.reason)) {
          breaker.trip(Math.max(e.retryAfterSeconds ?? 0, guard.blockCooldownSeconds), e.reason);
        }
        throw e;
      }
    });
    inflight.set(key, job);
    try {
      const product = await job;
      cache.set(key, product, guard.cacheTtlSeconds, guard.cacheMaxEntries);
      return { product, cached: false };
    } finally {
      inflight.delete(key);
    }
  }

  return { lookup, cache, limiter, breaker };
}

/** Shared guard used by the API and the web page. */
export const sharedGuard = createGuard();
