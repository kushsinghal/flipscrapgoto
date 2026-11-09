const env = process.env;
const production = (env.NODE_ENV ?? "").toLowerCase() === "production";

if (production) {
  const apiKeys = (env.API_KEYS ?? "").split(",").map((k) => k.trim()).filter((k) => k.length >= 16);
  const missing = [];
  if (apiKeys.length === 0) missing.push("API_KEYS (comma-separated, each at least 16 characters)");
  if (!env.UI_PASSWORD || env.UI_PASSWORD.length < 12) missing.push("UI_PASSWORD (at least 12 characters)");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) missing.push("SESSION_SECRET (at least 32 characters)");
  if (missing.length > 0) {
    console.error(`Refusing to start in production. Set: ${missing.join("; ")}`);
    process.exit(1);
  }
}

await import("../.output/server/index.mjs");
