import { describe, expect, it, vi } from "vitest";

import { debugRoute, productRoute, readyResponse } from "./api";
import { emptyProduct } from "./types";
import { corsHeaders, loadServerConfig, readApiKey, type ServerConfig } from "./security";

const KEY = "test-key-0123456789abcdef";
const URL_OK = "https://www.flipkart.com/x/p/itm1?pid=A";

const config = (over: Partial<ServerConfig> = {}): ServerConfig => ({
  apiKeys: [KEY],
  allowUnauthenticated: false,
  corsOrigins: [],
  debugEnabled: false,
  production: true,
  webLookupEnabled: true,
  ...over,
});

const req = (url = `http://x/api/public/product?url=${encodeURIComponent(URL_OK)}`, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

describe("API key protection", () => {
  it("rejects a request with no key", async () => {
    const scrape = vi.fn();
    const res = await productRoute(req(), { config: config(), scrape });
    expect(res.status).toBe(401);
    expect(scrape).not.toHaveBeenCalled();
  });

  it("rejects a key passed in the URL query", async () => {
    const scrape = vi.fn();
    const res = await productRoute(req(`http://x/api/public/product?url=${encodeURIComponent(URL_OK)}&api_key=${KEY}`), {
      config: config(),
      scrape,
    });
    expect(res.status).toBe(401);
    expect(scrape).not.toHaveBeenCalled();
  });

  it("accepts X-API-Key and Authorization: Bearer", async () => {
    const scrape = vi.fn(async () => emptyProduct(URL_OK));
    const viaHeader = await productRoute(req(undefined, { "X-API-Key": KEY }), { config: config(), scrape });
    const viaBearer = await productRoute(req(undefined, { Authorization: `Bearer ${KEY}` }), { config: config(), scrape });
    expect(viaHeader.status).toBe(200);
    expect(viaBearer.status).toBe(200);
  });

  it("rejects a wrong key", async () => {
    const res = await productRoute(req(undefined, { "X-API-Key": "wrong-key-0123456789" }), {
      config: config(),
      scrape: vi.fn(),
    });
    expect(res.status).toBe(401);
  });

  it("fails closed when no keys are configured", async () => {
    const res = await productRoute(req(undefined, { "X-API-Key": KEY }), { config: config({ apiKeys: [] }), scrape: vi.fn() });
    expect(res.status).toBe(401);
  });

  it("allows unauthenticated access only when explicitly enabled outside production", async () => {
    const scrape = vi.fn(async () => emptyProduct(URL_OK));
    const dev = await productRoute(req(), { config: config({ apiKeys: [], allowUnauthenticated: true, production: false }), scrape });
    expect(dev.status).toBe(200);
  });

  it("keeps the debug endpoint off by default", async () => {
    const res = await debugRoute(req(), { config: config({ debugEnabled: false }) });
    expect(res.status).toBe(404);
  });

  it("requires a key for the debug endpoint when it is enabled", async () => {
    const res = await debugRoute(req(), { config: config({ debugEnabled: true }), fetchPage: vi.fn() });
    expect(res.status).toBe(401);
  });
});

describe("config and key parsing", () => {
  it("ignores keys shorter than 16 characters", () => {
    expect(loadServerConfig({ API_KEYS: "short, " + KEY }).apiKeys).toEqual([KEY]);
  });

  it("reads the key from headers only", () => {
    expect(readApiKey(req(undefined, { "X-API-Key": " abc " }))).toBe("abc");
    expect(readApiKey(req(undefined, { Authorization: "Bearer xyz" }))).toBe("xyz");
    expect(readApiKey(req())).toBeNull();
  });
});

describe("CORS", () => {
  it("allows only configured origins", () => {
    const cfg = config({ corsOrigins: ["https://deals.example.com"] });
    expect(corsHeaders(req(undefined, { Origin: "https://deals.example.com" }), cfg)["Access-Control-Allow-Origin"]).toBe(
      "https://deals.example.com",
    );
    expect(corsHeaders(req(undefined, { Origin: "https://evil.example" }), cfg)).toEqual({});
  });
});

describe("readiness", () => {
  it("reports ready without contacting Flipkart when keys are configured", async () => {
    const res = await readyResponse({ API_KEYS: KEY, FETCH_MODE: "http" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ready");
  });

  it("reports not ready when no keys are configured", async () => {
    const res = await readyResponse({ FETCH_MODE: "http" });
    expect(res.status).toBe(503);
  });
});
