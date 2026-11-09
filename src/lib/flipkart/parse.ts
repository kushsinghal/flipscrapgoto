// Pure text helpers ported from the original scraper: price parsing, offer
// classification, SuperCoin detection, effective price and availability.
import type { BankOffer, CouponOffer, ExchangeOffer, SuperCoins } from "./types";

const FLIPKART_DOMAINS = ["flipkart.com"];

// Paths Flipkart's robots.txt disallows (plus the original project's list). The
// scraper never requests, follows a redirect to, or reports text pointing at these.
const DISALLOWED_PATH_PARTS = [
  "/offer-details", "/pbo-offer", "/payments-callout", "/seller-details", "/specifications",
  "/sellers", "/ps/", "/reviews/", "/product-reviews/", "/ratings-reviews-details-page",
  "/dynamic/", "/viewcart", "/login", "/swatch/", "/quick-view", "/rpd-product-details",
  "/product-emi-details", "/product-questions", "/answers/", "/item/product-delivery",
  "/item/product-warranty", "/item/seller-callout", "/pp/", "/pp-protect-promise-fee",
  "/amp/", "/search", "/sc/", "/affiliatewidget/", "/affiliate/", "/alliances/", "/3/product/",
  "/immerse", "/write-review/", "/write-question/", "/video-player", "/review-image",
  "/review-video", "/review-media", "/user-address", "/threed-main-compare-view",
  "/products-list/", "/all/", "/filters", "/rv/",
];
const DISALLOWED_QUERY_PARTS = [
  "colorselected=", "layout=", "primarysection=", "sizeselected=", "sort=", "page=", "=facets",
];
// Narrow list for free text (offer lines etc.), from the original project.
const DISALLOWED_TEXT_PARTS = [
  "/offer-details", "/pbo-offer", "/payments-callout", "/seller-details", "/specifications", "/sellers",
];

/** True when a URL points at a path or query Flipkart disallows for automated access. */
export function isDisallowedUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let path: string;
  let query: string;
  try {
    const u = new URL(url, "https://www.flipkart.com");
    path = u.pathname.toLowerCase();
    query = u.search.toLowerCase();
  } catch {
    return mentionsDisallowedPath(url);
  }
  if (DISALLOWED_PATH_PARTS.some((p) => path.includes(p))) return true;
  return DISALLOWED_QUERY_PARTS.some((q) => query.includes(q));
}

/** True when free text mentions a disallowed Flipkart path (e.g. "/offer-details"). */
export function mentionsDisallowedPath(text: string | null | undefined): boolean {
  if (!text) return false;
  const low = text.toLowerCase();
  return DISALLOWED_TEXT_PARTS.some((p) => low.includes(p));
}

// ---------------------------------------------------------------------------
// Validation (reject implausible values instead of guessing)
// ---------------------------------------------------------------------------
export function validatePrice(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parsePrice(String(v));
  return n !== null && Number.isFinite(n) && n > 0 && n < 100_000_000 ? n : null;
}

export function validatePercent(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parsePercent(String(v));
  return n !== null && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

export function validateRating(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloatLoose(String(v));
  return n !== null && Number.isFinite(n) && n >= 0 && n <= 5 ? n : null;
}

export function validateStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  if (!s || isDisallowedUrlText(s)) return null;
  return s;
}

function isDisallowedUrlText(s: string): boolean {
  return /^https?:\/\//i.test(s) ? isDisallowedUrl(s) : mentionsDisallowedPath(s);
}

const SELLER_NOISE = /^(advertise|advertise on flipkart|become a seller|see other sellers|sellers?|login|sign up|more|cart|flipkart assured|fulfilled by|sold by|visit brand store|location not set|select delivery location)$/i;

/** A seller name must look like a name: has letters, is not a rating/price/nav label. */
export function isPlausibleSellerName(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.trim();
  if (n.length < 2 || n.length > 80) return false;
  if (!/[a-z]/i.test(n)) return false;
  if (/^[\d.,\s★•|%₹-]+$/.test(n)) return false;
  if (/₹|%|\byears? with flipkart\b/i.test(n)) return false;
  return !SELLER_NOISE.test(n);
}

// Exact hosts a product page may be requested from. Subdomain tricks
// (flipkart.com.evil.net, evil.net/?flipkart.com) never match.
const PRODUCT_PAGE_HOSTS = new Set(["flipkart.com", "www.flipkart.com", "dl.flipkart.com"]);
const PRODUCT_PATH_RE = /\/p\/itm[a-z0-9]+(?:\/|$)/i;

function parseUrlSafe(url: string | URL): URL | null {
  try {
    return url instanceof URL ? url : new URL(url);
  } catch {
    return null;
  }
}

/** A URL Flipkart product pages may live on or redirect to: https/http, exact Flipkart host, default port, no credentials. */
export function isAllowedFlipkartPageUrl(url: string | URL): boolean {
  const u = parseUrlSafe(url);
  if (!u) return false;
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "443" && u.port !== "80") return false;
  return PRODUCT_PAGE_HOSTS.has(u.hostname.toLowerCase());
}

/** Hosts a headless browser may load page resources from (Flipkart and its static CDN). */
export function isAllowedResourceUrl(url: string | URL): boolean {
  const u = parseUrlSafe(url);
  if (!u || u.protocol !== "https:" || u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const h = u.hostname.toLowerCase();
  return FLIPKART_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`)) || h.endsWith(".flixcart.com");
}

/** True only for a Flipkart *product* URL: exact Flipkart host and a /p/itm… path. */
export function isFlipkartProductUrl(url: string | null | undefined): boolean {
  if (!url || url.length > 2048) return false;
  const u = parseUrlSafe(url.trim());
  if (!u || !isAllowedFlipkartPageUrl(u)) return false;
  return PRODUCT_PATH_RE.test(u.pathname);
}

/** The exact URL to request: https, no fragment, no credentials. Call after isFlipkartProductUrl. */
export function normalizeProductUrl(url: string): string {
  const u = new URL(url.trim());
  u.protocol = "https:";
  u.port = "";
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  return u.toString();
}

/** Stable cache key for a product page: path plus the pid that selects the variant. */
export function productCacheKey(url: string): string {
  const u = new URL(normalizeProductUrl(url));
  const pid = u.searchParams.get("pid") ?? "";
  const host = u.hostname === "flipkart.com" ? "www.flipkart.com" : u.hostname;
  return `${host}${u.pathname.replace(/\/+$/, "")}?pid=${pid}`;
}

/** Image URLs sometimes carry {@width}/{@height} templates; fill them so the link loads. */
export function normalizeImageUrl(url: string | null): string | null {
  if (!url) return null;
  const filled = url.replace(/\{@width\}/g, "832").replace(/\{@height\}/g, "832").replace(/\{@quality\}/g, "70");
  const u = parseUrlSafe(filled.startsWith("//") ? `https:${filled}` : filled);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
  u.protocol = "https:";
  return u.toString();
}

/** "RetailNet 4.5★" -> { name: "RetailNet", rating: 4.5 }. A name never keeps a trailing rating. */
export function splitSellerRating(text: string | null | undefined): { name: string | null; rating: number | null } {
  if (!text) return { name: null, rating: null };
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/^(.*?[a-z].*?)\s*[(|•·-]?\s*(\d(?:\.\d)?)\s*(?:★|stars?)?\s*\)?$/i);
  if (m && m[1] && !/\d$/.test(m[1])) {
    const rating = validateRating(Number(m[2]));
    if (rating !== null) return { name: m[1].replace(/[\s|•·(-]+$/, "").trim() || null, rating };
  }
  return { name: t || null, rating: null };
}

export const BANK_KEYWORDS = [
  "bank", "axis", "hdfc", "icici", "sbi", "kotak", "yes bank",
  "idfc", "rupay", "visa", "mastercard", "amex", "card", "emi", "no cost emi",
  "cashback",
];
export const COUPON_KEYWORDS = ["coupon", "code", "discount coupon", "apply coupon"];
export const EXCHANGE_KEYWORDS = ["exchange", "trade-in", "trade in", "buyback"];

/** Parse '₹29,990' or '46999' into a number. */
export function parsePrice(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseIntLoose(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[^\d]/g, "");
  if (!cleaned) return null;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

export function parsePercent(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

export function parseFloatLoose(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export function pidFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("pid");
  } catch {
    return null;
  }
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export function classifyBankOffer(line: string): BankOffer {
  const lower = line.toLowerCase();
  let offerType = "card offer";
  if (/\bemi\b/.test(lower)) offerType = "EMI offer";
  else if (lower.includes("cashback")) offerType = "cashback";

  let bankName: string | null = null;
  for (const b of ["axis", "hdfc", "icici", "sbi", "kotak", "yes bank", "idfc", "amex"]) {
    if (lower.includes(b)) {
      bankName = titleCase(b);
      break;
    }
  }
  if (bankName === null && lower.includes("bank")) {
    const m = lower.match(/(\w[\w ]*?)\s+bank/);
    if (m?.[1]) bankName = titleCase(m[1]);
  }

  let value: string | null = null;
  const m1 = line.match(/(up\s*to\s*)?[₹]\s*[\d,]+(?:\s*off)?/i);
  if (m1) value = m1[0].trim();
  if (value === null) {
    const m2 = line.match(/\d+%\s*off/i);
    if (m2) value = m2[0].trim();
  }

  return {
    title: line.slice(0, 200),
    offer_value: value,
    bank_name: bankName,
    offer_type: offerType,
    raw: line,
  };
}

export function classifyCoupon(line: string): CouponOffer {
  const lower = line.toLowerCase();
  const mc = line.match(/(?:code[:\s]+|use\s+)([A-Z0-9]{3,15})/);
  const mv = line.match(/(?:up\s*to\s*)?[₹]\s*[\d,]+(?:\s*off)?|\d+%\s*off/i);
  const mcond = line.match(/(?:on|above|min[a-z ]*)\s*[₹]\s*[\d,]+/i);
  const title = lower.includes("code") ? (line.split("code")[0] ?? "").trim() : line.slice(0, 200);
  return {
    title: title ? title.slice(0, 200) : line.slice(0, 200),
    coupon_value: mv ? mv[0].trim() : null,
    coupon_code: mc?.[1] ?? null,
    applicable_condition: mcond ? mcond[0].trim() : null,
    raw: line,
  };
}

export function classifyExchange(line: string): ExchangeOffer | null {
  const lower = line.toLowerCase();
  if (!EXCHANGE_KEYWORDS.some((k) => lower.includes(k))) return null;
  const m = line.match(/(?:up\s*to\s*)?[₹]\s*[\d,]+/i);
  const mc = line.match(/(?:on|with|for)[^₹]*[₹]\s*[\d,]+/i);
  return {
    title: line.slice(0, 200),
    max_exchange_value: m ? m[0].trim() : null,
    exchange_condition: mc ? mc[0].trim() : null,
    raw: line,
  };
}

export function detectSupercoins(pageText: string): SuperCoins {
  const lines = pageText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /super\s?coins?/i.test(l));
  if (lines.length === 0) return { earn: null, redeem: null, text: null, advertised_full_back: false };
  const text = lines.slice(0, 5).join(" | ");
  // Only lines that state an amount count; a bare mention of SuperCoins is not an earned or usable value.
  const earn = lines.find((l) => /\b(?:earn|get|win)\b/i.test(l) && /\d/.test(l)) ?? null;
  const redeem = lines.find((l) => /\b(?:redeem|use|pay|apply)\b/i.test(l) && /\d/.test(l)) ?? null;
  const advertised_full_back = lines.some((l) => /100\s*%\s*(?:back|cashback)/i.test(l));
  return { earn, redeem, text, advertised_full_back };
}

const isRange = (v: string) => /up\s*to/i.test(v);
// Conditions this estimate cannot check for one buyer and one item.
const UNKNOWN_ELIGIBILITY_RE =
  /\b\d+\s*items?\b|item\(s\)|\bon\s+(?:\d+|two|three|four|five)\s+or\s+more\b|\bbuy\s+\d+\b|\bcombo\b|\bfirst\s+(?:order|purchase|transaction)\b|\bnew\s+users?\b|\bnext\s+(?:order|purchase)\b|\bsupercoins?\b|\bcashback\b|\bexchange\b|\bemi\b/i;
const MIN_ORDER_RE =
  /(?:min(?:imum)?\.?\s*(?:order|purchase|txn|transaction|cart)\s*(?:value|amount)?\s*(?:of)?|on\s+orders?\s+(?:of|above|over)|orders?\s+above|above|over)\s*₹\s*([\d,]+)/i;

/** Flat ₹ amount an offer takes off this one item, or null when it cannot be known. */
function flatInstantDiscount(value: string | null, context: string, listedPrice: number): number | null {
  if (!value || isRange(value)) return null;
  if (!/₹/.test(value)) return null; // percentages without a stated cap: amount unknown
  if (UNKNOWN_ELIGIBILITY_RE.test(context)) return null;
  const amount = parsePrice(value);
  if (!amount || amount >= listedPrice) return null;
  const min = context.match(MIN_ORDER_RE);
  if (min) {
    const threshold = parsePrice(min[1]);
    if (threshold === null || threshold > listedPrice || threshold === amount) return null;
  }
  return amount;
}

/**
 * Our own estimate (never Flipkart's "Buy at" price): listed price minus at most one flat
 * bank instant discount and at most one flat coupon whose eligibility is clear. Never
 * subtracts exchange values, SuperCoins, cashback, EMI plans, "up to" ranges, uncapped
 * percentages or offers with conditions we cannot check. Null when nothing qualifies.
 */
export function computeEffectivePrice(
  listedPrice: number | null,
  bankOffers: BankOffer[],
  couponOffers: CouponOffer[],
  _exchange: ExchangeOffer | null,
  _supercoins: SuperCoins,
): number | null {
  if (listedPrice === null) return null;

  const best = (values: Array<number | null>) =>
    values.reduce<number>((m, v) => (v !== null && v > m ? v : m), 0);

  // One card pays for an order, so bank offers never stack with each other.
  const bank = best(
    bankOffers
      .filter((b) => b.offer_type === "card offer")
      .map((b) => flatInstantDiscount(b.offer_value, b.raw ?? b.title ?? "", listedPrice)),
  );
  // Coupons don't stack with each other either; any stated condition we can't check excludes it.
  const coupon = best(
    couponOffers.map((c) =>
      flatInstantDiscount(c.coupon_value, [c.applicable_condition, c.raw].filter(Boolean).join(" "), listedPrice),
    ),
  );

  const totalOff = bank + coupon;
  if (totalOff <= 0 || totalOff >= listedPrice) return null;
  return Math.round((listedPrice - totalOff) * 100) / 100;
}

export function mapAvailability(
  stockText: string | null,
  buyBtnText: string | null,
  structured: string | null = null,
): string | null {
  const s = (structured ?? "").toLowerCase();
  if (s.includes("outofstock") || s.includes("soldout") || s.includes("discontinued")) return "OUT_OF_STOCK";
  if (s.includes("preorder") || s.includes("presale")) return "PREORDER";
  if (s.includes("instock") || s.includes("in stock") || s.includes("limitedavailability")) return "IN_STOCK";
  if (!stockText && !buyBtnText) return null;
  const combined = [stockText, buyBtnText].filter(Boolean).join(" ").toLowerCase();
  if (
    ["out of stock", "currently unavailable", "not available", "sold out"].some((w) =>
      combined.includes(w),
    )
  )
    return "OUT_OF_STOCK";
  if (combined.includes("coming soon") || combined.includes("notify")) return "PREORDER";
  return "IN_STOCK";
}

/** Sort offer lines into bank / coupon / exchange buckets, same rules as the original. */
export function classifyOfferLines(lines: string[]): {
  bank_offers: BankOffer[];
  coupon_offers: CouponOffer[];
  exchange_offer: ExchangeOffer | null;
} {
  const bank: BankOffer[] = [];
  const coupons: CouponOffer[] = [];
  let exchange: ExchangeOffer | null = null;
  for (const line of lines) {
    const low = line.toLowerCase();
    if (BANK_KEYWORDS.some((k) => low.includes(k))) bank.push(classifyBankOffer(line));
    else if (COUPON_KEYWORDS.some((k) => low.includes(k))) coupons.push(classifyCoupon(line));
    const ex = classifyExchange(line);
    if (ex && exchange === null) exchange = ex;
  }
  return { bank_offers: bank, coupon_offers: coupons, exchange_offer: exchange };
}
