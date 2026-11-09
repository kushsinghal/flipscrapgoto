// Session-gated lookup for the web page. The browser never holds an API key: it proves it knows
// UI_PASSWORD once, receives a signed HttpOnly cookie, and only then can run server-side lookups.
import { createServerFn } from "@tanstack/react-start";
import { getCookie, setCookie } from "@tanstack/react-start/server";
import { z } from "zod";

import { webLookup, type WebLookupResult } from "./api";
import { loadServerConfig, keyMatches } from "./security";

const COOKIE = "fk_ui_session";
const SESSION_SECONDS = 8 * 60 * 60;

type SessionResult = { ok: true } | { ok: false; error: string; detail: string | null };

async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sessionSecret(): string | null {
  const secret = process.env["SESSION_SECRET"] ?? "";
  return secret.length >= 32 ? secret : null;
}

async function isSessionValid(token: string | undefined, secret: string): Promise<boolean> {
  if (!token) return false;
  const [expRaw, sig] = token.split(".");
  const exp = Number(expRaw);
  if (!sig || !Number.isFinite(exp) || exp * 1000 <= Date.now()) return false;
  return keyMatches(sig, await hmacHex(String(exp), secret));
}

const passwordSchema = z.object({ password: z.string().min(1).max(200) });
const urlSchema = z.object({ url: z.string().max(2048) });

export const unlockWebLookup = createServerFn({ method: "POST" })
  .inputValidator(passwordSchema)
  .handler(async ({ data }): Promise<SessionResult> => {
    const uiPassword = process.env["UI_PASSWORD"] ?? "";
    const secret = sessionSecret();
    if (uiPassword.length < 12 || !secret) {
      return { ok: false, error: "NOT_CONFIGURED", detail: "The web page is not set up yet. Ask the site owner to set UI_PASSWORD and SESSION_SECRET." };
    }
    if (!(await keyMatches(data.password, uiPassword))) {
      return { ok: false, error: "UNAUTHORIZED", detail: "That password is not right." };
    }
    const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    setCookie(COOKIE, `${exp}.${await hmacHex(String(exp), secret)}`, {
      httpOnly: true,
      sameSite: "strict",
      secure: loadServerConfig().production,
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    return { ok: true };
  });

export const lookupFromPage = createServerFn({ method: "POST" })
  .inputValidator(urlSchema)
  .handler(async ({ data }): Promise<WebLookupResult> => {
    const secret = sessionSecret();
    const valid = secret !== null && (await isSessionValid(getCookie(COOKIE), secret));
    if (!valid) {
      return { ok: false, error: "UNAUTHORIZED", detail: "Enter the access password to look up a product." };
    }
    return webLookup(data.url);
  });
