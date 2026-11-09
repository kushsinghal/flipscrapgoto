// API-key authentication and CORS for the public HTTP API. Config is read from the
// environment inside each request (edge runtimes inject env per request).
import type { ErrorResponse } from "./types";

export interface ServerConfig {
  apiKeys: string[];
  /** Local development only: lets requests through when no API keys are configured. */
  allowUnauthenticated: boolean;
  /** Exact origins allowed for browser calls; "*" allows any origin (not recommended). */
  corsOrigins: string[];
  debugEnabled: boolean;
  production: boolean;
  webLookupEnabled: boolean;
}

const truthy = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function loadServerConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const production = (env["NODE_ENV"] ?? "").toLowerCase() === "production" || (env["APP_ENV"] ?? "").toLowerCase() === "production";
  return {
    apiKeys: [...list(env["API_KEYS"]), ...list(env["API_KEY"])].filter((k) => k.length >= 16),
    allowUnauthenticated: !production && truthy(env["ALLOW_UNAUTHENTICATED"]),
    corsOrigins: list(env["CORS_ORIGINS"]).map((o) => o.replace(/\/+$/, "")),
    debugEnabled: truthy(env["ENABLE_DEBUG_ENDPOINT"]),
    production,
    webLookupEnabled: env["ENABLE_WEB_LOOKUP"] === undefined ? true : truthy(env["ENABLE_WEB_LOOKUP"]),
  };
}

function errorJson(status: number, error: string, detail: string, headers: Record<string, string> = {}): Response {
  const body: ErrorResponse = { status: "error", error, detail };
  return Response.json(body, { status, headers });
}

/** Key from `X-API-Key: <key>` or `Authorization: Bearer <key>`. Query-string keys are refused (they end up in logs). */
export function readApiKey(request: Request): string | null {
  const header = request.headers.get("x-api-key");
  if (header) return header.trim();
  const auth = request.headers.get("authorization");
  const m = auth?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant-time comparison of SHA-256 digests, so timing reveals nothing about a key. */
export async function keyMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Returns an error Response when the request is not authorised, otherwise null. */
export async function requireApiKey(request: Request, config: ServerConfig): Promise<Response | null> {
  if (new URL(request.url).searchParams.has("api_key")) {
    return errorJson(401, "UNAUTHORIZED", "Send the API key in the X-API-Key header, not the URL.");
  }
  if (config.apiKeys.length === 0) {
    if (config.allowUnauthenticated) return null;
    return errorJson(401, "UNAUTHORIZED", "API key required. The server has no API_KEYS configured yet.", {
      "WWW-Authenticate": 'Bearer realm="flipkart-api"',
    });
  }
  const given = readApiKey(request);
  if (!given) {
    return errorJson(401, "UNAUTHORIZED", "Missing API key. Send it as X-API-Key or Authorization: Bearer.", {
      "WWW-Authenticate": 'Bearer realm="flipkart-api"',
    });
  }
  let ok = false;
  for (const k of config.apiKeys) if (await keyMatches(given, k)) ok = true; // check all keys: constant work
  return ok ? null : errorJson(401, "UNAUTHORIZED", "Invalid API key.");
}

export function corsHeaders(request: Request, config: ServerConfig): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || config.corsOrigins.length === 0) return {};
  const allowAny = config.corsOrigins.includes("*");
  if (!allowAny && !config.corsOrigins.includes(origin.replace(/\/+$/, ""))) return {};
  return {
    "Access-Control-Allow-Origin": allowAny ? "*" : origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "X-API-Key, Authorization, Content-Type",
    "Access-Control-Expose-Headers": "Retry-After, X-Cache",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function preflight(request: Request, config: ServerConfig): Response {
  const headers = corsHeaders(request, config);
  return new Response(null, { status: Object.keys(headers).length ? 204 : 403, headers });
}

export function withHeaders(res: Response, headers: Record<string, string>): Response {
  if (!Object.keys(headers).length) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}
