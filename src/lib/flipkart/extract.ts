// Flipkart product page extraction from HTML (pure, no network).
//
// Layers, in priority order; every field records its source in extraction_trace:
//   1. Structured data: JSON-LD, embedded product state, meta tags, canonical link, pid in URL.
//   2. Main product section: visible text after the product <h1>, before "Similar Products".
//      The MRP is the struck-through price next to the selling price; the seller comes only
//      from the seller block ("Fulfilled by …" / "Sold by …" / "Seller").
//   3. DOM fallback: CSS selectors (data-testid / aria-label first, older class names last).
//   4. Cross-field validation: implausible values are dropped with a note, never guessed.
//
// Hidden content (opacity:0, display:none, visibility:hidden, aria-hidden) and other
// products' cards (links to another /p/ page) are ignored everywhere.
import { parse, type HTMLElement } from "node-html-parser";

import { FlipkartBlockedError, FlipkartNotFoundError } from "./errors";
import {
  classifyBankOffer,
  classifyCoupon,
  computeEffectivePrice,
  detectSupercoins,
  isDisallowedUrl,
  isPlausibleSellerName,
  mapAvailability,
  mentionsDisallowedPath,
  parseFloatLoose,
  parseIntLoose,
  parsePercent,
  parsePrice,
  normalizeImageUrl,
  pidFromUrl,
  splitSellerRating,
  validatePercent,
  validatePrice,
  validateRating,
  validateStr,
} from "./parse";
import {
  emptyProduct,
  type BankOffer,
  type CouponOffer,
  type ExchangeOffer,
  type ProductResponse,
  type Variant,
} from "./types";

// ---------------------------------------------------------------------------
// DOM fallback selectors (last resort). Add new selectors to the FRONT of a list.
// ---------------------------------------------------------------------------
export const SELECTORS = {
  title: ['[data-testid="product-title"]', "h1 span", "h1"],
  listed_price: [
    '[data-testid="price"]',
    "div.Nx9bqQ.CxhGGd",
    "div._30jeq3._16Jk6d",
    "div._25b18c div._30jeq3",
  ],
  mrp: ['[data-testid="mrp"]', "div.yRaY8b", "div._3I9_wc._2p6yqV", "div._3I9_wc", "span.YBaYDo"],
  discount_percent: ['[data-testid="discount"]', "div.UkUFwK", "div._3Ay6Sb._31z_c7", "div._3Ay6Sb"],
  rating: ['[data-testid="rating"]', "div.XQDdUU._3Fe1uu", "div._3LWZlK", "div.gUVU3N"],
  rating_count: ['[data-testid="rating-count"]', "span.WQhi9r", "span._2_R_Dj"],
  review_count: ['[data-testid="review-count"]', "span.jGHbW"],
  image: ['[data-testid="image-container"] img', "img._39dcsN", "img._2r_T1I", "img.VU3EsN"],
  availability: [
    '[data-testid="availability"]',
    'button[aria-label*="cart"]',
    'button[aria-label*="Cart"]',
    'button[aria-label*="buy"]',
    'button[aria-label*="Buy"]',
    "button._2KpZ6l._2U9uKW",
  ],
  stock_text: ['[data-testid="stock-text"]', "div._16pYZm div", "div._1dVbu9 div"],
  seller_name: ['[data-testid="seller-name"]', "div#sellerName", "a._1__OLb._2kEz-_"],
  seller_rating: ['[data-testid="seller-rating"]', "div._3LWZlK._3l3hSa", "span._1l3-Xk"],
  delivery_text: ['[data-testid="delivery"]', "div._1jlgF0", "div._3ebL2g span"],
  brand: ['[data-testid="brand"]', "span._2V8TR4"],
  offers_container: [
    '[data-testid="offers"]',
    'div[aria-label*="offers"]',
    'div[aria-label*="Offers"]',
    "div._17Bz-0",
    "div._1mslJ8",
    "section._17Bz-0",
  ],
  specifications_container: [
    '[data-testid="specifications"]',
    "div._3YDCG-",
    "div._1G2m-e",
    "div#specs-container",
  ],
  variant_selectors: ['[data-testid="variant"]', "a._1_47mG", "li._3VUKTt"],
} satisfies Record<string, string[]>;

type SelectorKey = keyof typeof SELECTORS;

// ---------------------------------------------------------------------------
// Visible text lines in document order
// ---------------------------------------------------------------------------
export interface TextLine {
  text: string;
  hidden: boolean;
  /** Inside a link to a /p/ page, i.e. another product's card (ads, carousels, swatches). */
  inOtherProduct: boolean;
  inLink: boolean;
  /** Rendered with a line-through (inline style or <del>/<s>). */
  strike: boolean;
  inH1: boolean;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "TEMPLATE", "HEAD", "IFRAME"]);

function styleOf(el: HTMLElement): string {
  return (el.getAttribute("style") ?? "").toLowerCase().replace(/\s+/g, "");
}

function hidesSelf(el: HTMLElement): boolean {
  const s = styleOf(el);
  return (
    /(^|;)opacity:0(\.0+)?(;|$)/.test(s) ||
    /(^|;)display:none/.test(s) ||
    /(^|;)visibility:hidden/.test(s) ||
    el.getAttribute("aria-hidden") === "true" ||
    el.hasAttribute("hidden")
  );
}

function isProductLink(el: HTMLElement): boolean {
  return el.tagName === "A" && (el.getAttribute("href") ?? "").includes("/p/");
}

export function buildLines(root: HTMLElement): TextLine[] {
  const out: TextLine[] = [];
  type Ctx = Omit<TextLine, "text">;
  const walk = (node: HTMLElement, ctx: Ctx) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const t = child.text.replace(/\s+/g, " ").trim();
        if (t) out.push({ text: t, ...ctx });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as HTMLElement;
      if (SKIP_TAGS.has(el.tagName)) continue;
      const s = styleOf(el);
      walk(el, {
        hidden: ctx.hidden || hidesSelf(el),
        inOtherProduct: ctx.inOtherProduct || isProductLink(el),
        inLink: ctx.inLink || el.tagName === "A",
        strike: ctx.strike || s.includes("line-through") || ["DEL", "S", "STRIKE"].includes(el.tagName),
        inH1: ctx.inH1 || el.tagName === "H1",
      });
    }
  };
  walk(root, { hidden: false, inOtherProduct: false, inLink: false, strike: false, inH1: false });
  return out;
}

function isHiddenOrForeign(el: HTMLElement): boolean {
  let cur: HTMLElement | null = el;
  while (cur && cur.tagName) {
    if (hidesSelf(cur) || isProductLink(cur)) return true;
    cur = cur.parentNode as HTMLElement | null;
  }
  return false;
}

function visibleTextOf(el: HTMLElement): string[] {
  return buildLines(el)
    .filter((l) => !l.hidden && !l.inOtherProduct)
    .map((l) => l.text);
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------
function safeQueryAll(root: HTMLElement, sel: string): HTMLElement[] {
  try {
    return root.querySelectorAll(sel);
  } catch {
    return [];
  }
}

function domFirstText(root: HTMLElement, key: SelectorKey): string | null {
  for (const sel of SELECTORS[key] as string[]) {
    for (const el of safeQueryAll(root, sel)) {
      if (isHiddenOrForeign(el)) continue;
      const txt = visibleTextOf(el).join(" ").trim();
      if (txt) return txt;
    }
  }
  return null;
}

function domFirstAttr(root: HTMLElement, key: SelectorKey, attr: string): string | null {
  for (const sel of SELECTORS[key] as string[]) {
    for (const el of safeQueryAll(root, sel)) {
      if (isHiddenOrForeign(el)) continue;
      const v = el.getAttribute(attr)?.trim();
      if (v) return v;
    }
  }
  return null;
}

function metaMap(root: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of safeQueryAll(root, "meta")) {
    const k = m.getAttribute("property") ?? m.getAttribute("name") ?? m.getAttribute("itemprop");
    const v = m.getAttribute("content");
    if (k && v && !(k in out)) out[k] = v.trim();
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// ---------------------------------------------------------------------------
// Layer 1: structured data
// ---------------------------------------------------------------------------
type Structured = {
  [K in keyof StructuredFields]?: StructuredFields[K] | undefined;
};
type StructuredFields = {
  title: string;
  brand: string;
  image_url: string;
  product_id: string;
  listed_price: number;
  mrp: number;
  currency: string;
  availability: string;
  seller_name: string;
  rating: number;
  rating_count: number;
  review_count: number;
  discount_percent: number;
  price_with_offers: number;
  delivery_text: string;
};

const asNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && String(v).trim() !== "" ? n : null;
};

function collectLdBlocks(root: HTMLElement): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(push);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o["@graph"]) push(o["@graph"]);
      out.push(o);
    }
  };
  for (const s of safeQueryAll(root, 'script[type="application/ld+json"]')) {
    try {
      push(JSON.parse(s.rawText));
    } catch {
      continue;
    }
  }
  return out;
}

export function parseJsonLd(blocks: Record<string, unknown>[]): Structured {
  const r: Structured = {};
  // Product blocks first; fall back to any block with product-like keys.
  const isProduct = (b: Record<string, unknown>) => {
    const t = b["@type"];
    return t === "Product" || (Array.isArray(t) && t.includes("Product"));
  };
  const ordered = [...blocks.filter(isProduct), ...blocks.filter((b) => !isProduct(b) && !b["@type"])];
  for (const b of ordered) {
    if (typeof b["name"] === "string") r.title ??= b["name"];
    const img = b["image"];
    if (Array.isArray(img) && typeof img[0] === "string") r.image_url ??= img[0];
    else if (typeof img === "string") r.image_url ??= img;
    const brand = b["brand"];
    if (typeof brand === "string") r.brand ??= brand;
    else if (brand && typeof brand === "object" && typeof (brand as { name?: unknown }).name === "string")
      r.brand ??= (brand as { name: string }).name;
    if (typeof b["sku"] === "string") r.product_id ??= b["sku"];
    else if (typeof b["mpn"] === "string") r.product_id ??= b["mpn"];

    const offersRaw = b["offers"];
    const offers = (Array.isArray(offersRaw) ? offersRaw : offersRaw ? [offersRaw] : []) as Record<string, unknown>[];
    for (const o of offers) {
      if (!o || typeof o !== "object") continue;
      const price = asNum(o["price"] ?? o["lowPrice"]);
      if (price !== null) r.listed_price ??= price;
      if (typeof o["priceCurrency"] === "string") r.currency ??= o["priceCurrency"];
      if (typeof o["availability"] === "string") r.availability ??= o["availability"];
      const ps = o["priceSpecification"] as Record<string, unknown> | undefined;
      if (ps && typeof ps === "object") {
        const mrp = asNum(ps["maxPrice"] ?? ps["price"]);
        if (mrp !== null) r.mrp ??= mrp;
      }
      const seller = o["seller"] as Record<string, unknown> | undefined;
      if (seller && typeof seller === "object" && typeof seller["name"] === "string") r.seller_name ??= seller["name"];
    }

    const agg = b["aggregateRating"] as Record<string, unknown> | undefined;
    if (agg && typeof agg === "object") {
      const rv = asNum(agg["ratingValue"]);
      if (rv !== null) r.rating ??= rv;
      const rc = asNum(agg["ratingCount"]);
      const rev = asNum(agg["reviewCount"]);
      // ratingCount is the number of ratings; reviewCount the written reviews.
      // Older pages only expose reviewCount, which then stands for the rating count.
      if (rc !== null) {
        r.rating_count ??= rc;
        if (rev !== null) r.review_count ??= rev;
      } else if (rev !== null) r.rating_count ??= rev;
    }
  }
  return r;
}

/** Extract a balanced JSON object starting at `start` (which must be "{"). */
export function extractBalancedJson(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const STATE_FIELD_MAP: Record<string, keyof Structured> = {
  title: "title",
  name: "title",
  price: "listed_price",
  mrp: "mrp",
  maxPrice: "mrp",
  listPrice: "mrp",
  discountPercentage: "discount_percent",
  discount: "discount_percent",
  imageUrl: "image_url",
  image: "image_url",
  brand: "brand",
  sellerName: "seller_name",
  seller: "seller_name",
  rating: "rating",
  ratingValue: "rating",
  ratingCount: "rating_count",
  // In embedded state reviewCount has been the ratings total (same as the original scraper).
  reviewCount: "rating_count",
  deliveryText: "delivery_text",
  availability: "availability",
  priceWithOffers: "price_with_offers",
};
const NUMERIC_STATE_FIELDS = new Set<keyof Structured>([
  "listed_price", "mrp", "discount_percent", "rating", "rating_count", "review_count", "price_with_offers",
]);

function flattenProductState(state: Record<string, unknown>, depth = 0, out: Structured = {}): Structured {
  if (depth > 6) return out;
  for (const [rawKey, target] of Object.entries(STATE_FIELD_MAP)) {
    if (!(rawKey in state) || target in out) continue;
    const v = state[rawKey];
    if (v === null || v === undefined || typeof v === "object") continue;
    if (NUMERIC_STATE_FIELDS.has(target)) {
      const n = asNum(v);
      if (n !== null) (out as Record<string, unknown>)[target] = n;
    } else (out as Record<string, unknown>)[target] = String(v);
  }
  for (const v of Object.values(state)) {
    if (v && typeof v === "object" && !Array.isArray(v)) flattenProductState(v as Record<string, unknown>, depth + 1, out);
  }
  return out;
}

/** Only objects stored under a "product" key are read, so site-wide config never leaks in. */
function findProductNodes(v: unknown, depth = 0, out: Record<string, unknown>[] = []) {
  if (depth > 8 || !v || typeof v !== "object") return out;
  if (Array.isArray(v)) {
    for (const item of v) findProductNodes(item, depth + 1, out);
    return out;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k.toLowerCase() === "product" && val && typeof val === "object" && !Array.isArray(val)) {
      out.push(val as Record<string, unknown>);
    } else findProductNodes(val, depth + 1, out);
  }
  return out;
}

export function extractEmbeddedState(scriptTexts: string[]): Structured {
  const result: Structured = {};
  for (const text of scriptTexts) {
    if (!text) continue;
    const candidates: unknown[] = [];
    for (const v of ["__NEXT_DATA__", "__PRELOADED_STATE__", "__INITIAL_STATE__"]) {
      const m = new RegExp(`${v}\\s*=\\s*\\{`).exec(text);
      if (!m) continue;
      const json = extractBalancedJson(text, m.index + m[0].length - 1);
      if (!json) continue;
      try {
        candidates.push(JSON.parse(json));
      } catch {
        continue;
      }
    }
    const trimmed = text.trim();
    if (!candidates.length && trimmed.startsWith("{") && /"product"\s*:/.test(trimmed)) {
      try {
        candidates.push(JSON.parse(trimmed));
      } catch {
        // not JSON
      }
    }
    for (const c of candidates) {
      for (const node of findProductNodes(c)) {
        const flat = flattenProductState(node);
        for (const [k, val] of Object.entries(flat)) {
          if (!(k in result)) (result as Record<string, unknown>)[k] = val;
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Layer 2: main product section
// ---------------------------------------------------------------------------
const MAIN_STOP_RE =
  /^(similar products|hang on, loading content|ratings (?:and|&) reviews|questions and answers|more about\b|top stories|you might (?:also )?(?:be interested in|like)|frequently bought together|recently viewed|customers also (?:bought|viewed))/i;
const PRICE_RE = /^₹\s?[\d,]+(?:\.\d+)?$/;
const PRICE_LIKE_RE = /^₹?\s?\d[\d,]*(?:\.\d+)?$/;
const PERCENT_RE = /^(\d{1,2}(?:\.\d+)?)\s*%(?:\s*off)?$/i;
const LOCATION_HINT_RE = /location not set|select delivery location|enter (?:delivery )?pincode|^deliver to$/im;

interface MainZone {
  lines: TextLine[];
  scope: "main" | "page";
  titleEnd: number; // index just after the title lines, or 0
}

function mainZone(visible: TextLine[], titleHint: string | null): MainZone {
  let start = visible.findIndex((l) => l.inH1);
  if (start < 0 && titleHint) {
    const hint = norm(titleHint);
    start = visible.findIndex((l) => norm(l.text).startsWith(hint));
  }
  const scope = start >= 0 ? "main" : "page";
  const from = Math.max(start, 0);
  let titleEnd = from;
  while (titleEnd < visible.length && visible[titleEnd]!.inH1) titleEnd++;
  if (start >= 0 && titleEnd === from) titleEnd = from + 1;
  let end = visible.findIndex((l, i) => i > from && MAIN_STOP_RE.test(l.text));
  if (end < 0) end = visible.length;
  return { lines: visible.slice(from, end), scope, titleEnd: start >= 0 ? titleEnd - from : 0 };
}

function findPriceIndex(lines: TextLine[], listed: number | null): number {
  const priceLines = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => !l.strike && PRICE_RE.test(l.text));
  if (listed !== null) {
    const exact = priceLines.find(({ l }) => parsePrice(l.text) === listed);
    if (exact) return exact.i;
  }
  return priceLines[0]?.i ?? -1;
}

function near(lines: TextLine[], center: number, radius: number, from = 0): TextLine[] {
  if (center < 0) return lines.slice(from, from + 25);
  return lines.slice(Math.max(from, center - radius), center + radius + 1);
}

interface SellerHit {
  name: string;
  rating: number | null;
}

/** Seller only from its own block: "Fulfilled by X", "Sold by X", or a "Seller" label followed by the name. */
export function findSeller(lines: string[]): SellerHit | null {
  const ratingAfter = (i: number): number | null => {
    for (const t of lines.slice(i + 1, i + 3)) {
      if (/^\d(?:\.\d)?$/.test(t)) return validateRating(Number(t));
    }
    return null;
  };
  // A name with a rating glued on ("RetailNet4.5", "RetailNet 4.5 ★") is split in two.
  const hit = (raw: string, i: number): SellerHit | null => {
    const { name, rating } = splitSellerRating(raw);
    if (!name || !isPlausibleSellerName(name)) return null;
    return { name, rating: rating ?? ratingAfter(i) };
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!;
    let m = t.match(/^(?:fulfilled by|sold by)\s*:?\s*(.+)$/i);
    if (m) {
      const h = hit(m[1]!, i);
      if (h) return h;
    }
    m = t.match(/^seller\s*:\s*(.+)$/i);
    if (m) {
      const h = hit(m[1]!, i);
      if (h) return h;
    }
    if (/^seller\s*:?$/i.test(t)) {
      const next = lines[i + 1];
      const h = next ? hit(next, i + 1) : null;
      if (h) return h;
    }
  }
  return null;
}

export function findDelivery(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!;
    const tidy = (s: string) => s.replace(/\s*\|\s*/g, " | ").replace(/\s+/g, " ").trim();
    let m = t.match(/^delivery\s*by\s*(.{3,60})$/i);
    if (m) return tidy(`Delivery by ${m[1]}`);
    if (/^delivery$/i.test(t)) {
      m = (lines[i + 1] ?? "").match(/^by\s*(.{3,60})$/i);
      if (m) return tidy(`Delivery by ${m[1]}`);
    }
    m = t.match(/^(free delivery.{0,50})$/i);
    if (m) return tidy(m[1]!);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Offers: grouped into visible cards, classified only when the label is clear
// ---------------------------------------------------------------------------
type OfferCategory = "bank" | "coupon" | "exchange" | "supercoin" | "special" | "other";
interface OfferCard {
  label: string | null;
  category: OfferCategory;
  lines: string[];
}

const OFFER_HEADER_RE =
  /^(bank offers?|coupons?|coupon offers?|exchange offers?|partner offers?|special price|no cost emi|emi offers?|combo offers?|supercoins?(?: offers?)?)$/i;
const OFFER_REGION_RE = /^(available offers|offers for you|offers|apply offers for maximum savings|offers? \(\d+\))$/i;
const OFFER_PREFIX_RE = /^(bank offer|special price|partner offer|combo offer|no cost emi|exchange offer|coupon offer)\s*(\S.{3,})$/i;
const OFFER_NOISE_RE =
  /^(apply|apply now|t ?& ?c|know more|read more|view (?:plans|details|all)|view emi offers|show more|details|\+\s*\d+ more offers?|buy at\s*₹.*)$/i;
const OFFER_STOP_RE =
  /^(delivery details|deliver to|delivery|delivery\s*by.*|fulfilled by.*|sold by.*|seller:?|services|product highlights|product details|highlights|specifications|all details|add to cart|buy now|notify me|see other sellers|select delivery location|location not set)$/i;

function offerCategory(text: string): OfferCategory | null {
  const t = text.toLowerCase();
  if (/coupon/.test(t)) return "coupon";
  if (/exchange|trade-?in|buyback/.test(t)) return "exchange";
  if (/super\s?coin/.test(t)) return "supercoin";
  if (/special price/.test(t)) return "special";
  if (/\bbank\b|credit card|debit card|\bemi\b|cashback|\baxis\b|\bhdfc\b|\bicici\b|\bsbi\b|\bkotak\b|rupay|\bvisa\b|mastercard|\bamex\b|bobcard/.test(t))
    return "bank";
  return null;
}

export function buildOfferCards(lines: string[], explicitContainer: boolean): { cards: OfferCard[]; collapsed: string[] } {
  const cards: OfferCard[] = [];
  const collapsed: string[] = [];
  let region = explicitContainer;
  let cur: OfferCard | null = null;
  const close = () => {
    if (cur) {
      if (cur.lines.length) cards.push(cur);
      else if (cur.label) collapsed.push(cur.label);
    }
    cur = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || mentionsDisallowedPath(line)) continue;
    if (!explicitContainer && OFFER_STOP_RE.test(line)) {
      close();
      region = false;
      continue;
    }
    if (OFFER_REGION_RE.test(line)) {
      close();
      region = true;
      continue;
    }
    if (OFFER_HEADER_RE.test(line)) {
      close();
      region = true;
      cur = { label: line, category: offerCategory(line) ?? "other", lines: [] };
      continue;
    }
    if (!region || OFFER_NOISE_RE.test(line)) continue;
    const pm = line.match(OFFER_PREFIX_RE);
    if (pm) {
      close();
      cards.push({ label: pm[1]!, category: offerCategory(pm[1]!) ?? "other", lines: [line] });
      continue;
    }
    const cat = offerCategory(line);
    const open = cur as OfferCard | null;
    if (open && (cat === null || cat === open.category)) {
      open.lines.push(line);
      continue;
    }
    if (cat) {
      close();
      cur = { label: null, category: cat, lines: [line] };
    }
  }
  close();

  // De-duplicate repeated cards (Flipkart renders some cards twice).
  const unique: OfferCard[] = [];
  for (const c of cards) {
    const dup = unique.some(
      (u) => u.category === c.category && c.lines.every((l) => u.lines.includes(l)),
    );
    if (!dup) unique.push(c);
  }
  const shownLabels = new Set(unique.map((c) => norm(c.label ?? "")));
  return {
    cards: unique,
    collapsed: [...new Set(collapsed)].filter((l) => !shownLabels.has(norm(l))),
  };
}

function cardRaw(c: OfferCard): string {
  const body = c.lines.join(" | ");
  return c.label && !norm(c.lines[0] ?? "").startsWith(norm(c.label)) ? `${c.label}: ${body}` : body;
}

function classifyCards(cards: OfferCard[]) {
  const bank: BankOffer[] = [];
  const coupons: CouponOffer[] = [];
  let exchange: ExchangeOffer | null = null;
  for (const c of cards) {
    const joined = c.lines.join(" · ");
    const raw = cardRaw(c);
    if (c.category === "bank") {
      bank.push({ ...classifyBankOffer(joined), raw });
    } else if (c.category === "coupon") {
      const co = classifyCoupon(joined);
      if (c.lines.length > 1 && !co.applicable_condition) co.applicable_condition = c.lines.slice(1).join(" · ");
      coupons.push({ ...co, title: c.lines[0]!.slice(0, 200), raw });
    } else if (c.category === "exchange" && exchange === null) {
      const m = joined.match(/(?:up\s*to\s*)?₹\s*[\d,]+/i);
      if (m) {
        exchange = { title: joined.slice(0, 200), max_exchange_value: m[0].trim(), exchange_condition: null, raw };
      }
    }
  }
  return { bank, coupons, exchange };
}

// ---------------------------------------------------------------------------
// Specifications and variants
// ---------------------------------------------------------------------------
function rowsToSpecs(rows: HTMLElement[], specs: Record<string, string>) {
  for (const row of rows) {
    if (isHiddenOrForeign(row)) continue;
    if (row.tagName === "TR") {
      const cells = safeQueryAll(row, "td, th").map((c) => visibleTextOf(c).join(" ").trim()).filter(Boolean);
      if (cells.length >= 2) specs[cells[0]!] = cells.slice(1).join(", ");
    } else {
      const parts = visibleTextOf(row);
      if (parts.length === 2) specs[parts[0]!] = parts[1]!;
    }
  }
}

function extractSpecifications(root: HTMLElement): { specs: Record<string, string>; source: string | null } {
  const specs: Record<string, string> = {};
  for (const sel of SELECTORS.specifications_container) {
    const container = safeQueryAll(root, sel).find((el) => !isHiddenOrForeign(el));
    if (!container) continue;
    rowsToSpecs(safeQueryAll(container, "tr, div.row, li"), specs);
    if (Object.keys(specs).length) return { specs, source: "dom:specifications_container" };
  }
  rowsToSpecs(safeQueryAll(root, "table tr"), specs);
  if (Object.keys(specs).length) return { specs, source: "dom:table" };
  // Current layout: "Product highlights" grid, one key/value pair per cell.
  rowsToSpecs(safeQueryAll(root, "div.grid-formation"), specs);
  if (Object.keys(specs).length) return { specs, source: "dom:product_highlights" };
  return { specs, source: null };
}

function extractVariants(
  root: HTMLElement,
  visible: TextLine[],
  currentPid: string | null,
): { variants: Variant[]; source: string | null } {
  const lines = visible.map((l) => l.text);
  const variants: Variant[] = [];
  // Current layout: "Selected Dial Color:" followed by the selected value.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^selected\s+(.{2,40}?)\s*:\s*(.*)$/i);
    if (!m) continue;
    const value = m[2]?.trim() || lines[i + 1] || null;
    if (value && !/^selected\s/i.test(value) && !/^out of stock$/i.test(value)) {
      variants.push({ name: m[1]!.trim(), value: value.trim(), options: [] });
    }
  }
  if (variants.length) return { variants: variants.slice(0, 20), source: "semantic:selected_label" };
  // Older layout: "Strap Color", options…, "Please select a Strap Color to proceed".
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^please select an? (.{2,40}?) to proceed/i);
    if (!m) continue;
    const name = m[1]!.trim();
    const j = lines.lastIndexOf(name, i - 1);
    if (j >= 0 && i - j <= 30) {
      const options = lines.slice(j + 1, i).filter((o) => o.length <= 40);
      if (options.length) variants.push({ name, value: null, options });
    }
  }
  if (variants.length) return { variants: variants.slice(0, 20), source: "semantic:variant_group" };
  // DOM fallback: the swatches are *available options*. Only the one marked as selected
  // (aria-selected/aria-checked/aria-current, a "selected" class, or a link to this page's
  // own pid) becomes the selected value; otherwise the selected value stays null.
  for (const sel of SELECTORS.variant_selectors) {
    const els = safeQueryAll(root, sel).filter(
      (el) => !isHiddenOrForeign(el) || el.getAttribute("data-testid") === "variant",
    );
    const options: string[] = [];
    let selected: string | null = null;
    for (const el of els) {
      const text = el.text.replace(/\s+/g, " ").trim();
      if (!text || options.includes(text)) continue;
      options.push(text);
      if (selected === null && isSelectedOption(el, currentPid)) selected = text;
    }
    if (options.length) {
      return {
        variants: [{ name: null, value: selected, options: options.slice(0, 20) }],
        source: selected ? "dom:fallback(selected_marked)" : "dom:fallback(options_only)",
      };
    }
  }
  return { variants, source: null };
}

function isSelectedOption(el: HTMLElement, currentPid: string | null): boolean {
  if (["true", "page"].includes((el.getAttribute("aria-selected") ?? el.getAttribute("aria-checked") ?? el.getAttribute("aria-current") ?? "").toLowerCase()))
    return true;
  if (/\b(selected|active|is-selected)\b/i.test(el.getAttribute("class") ?? "")) return true;
  const href = el.getAttribute("href");
  if (currentPid && href) {
    try {
      return new URL(href, "https://www.flipkart.com/").searchParams.get("pid") === currentPid;
    } catch {
      return false;
    }
  }
  return false;
}

/** Text markers of a block page, checked only on short pages or in the <title>. */
const BLOCK_TEXT_RE: Array<[RegExp, "captcha" | "access_denied" | "rate_limited"]> = [
  [/are you a (?:robot|human)|verify (?:that )?you(?:'re| are) (?:a )?human|captcha|security check/i, "captcha"],
  [/too many requests|unusual traffic|rate limit/i, "rate_limited"],
  [/access denied|request (?:was )?blocked|forbidden|you don't have permission/i, "access_denied"],
];

/**
 * Detects CAPTCHA / access-denied / rate-limit pages before extraction. Looks at the page
 * title, visible CAPTCHA widgets and the visible text of short pages, so scripts on a
 * normal product page that merely mention "recaptcha" never trigger it.
 */
export function detectBlockReason(html: string): "captcha" | "access_denied" | "rate_limited" | null {
  if (!html) return null;
  const root = parse(html, { comment: false });
  const title = root.querySelector("title")?.text.trim() ?? "";
  for (const [re, reason] of BLOCK_TEXT_RE) if (re.test(title)) return reason;
  const widget = safeQueryAll(root, 'iframe[src*="captcha"], .g-recaptcha, .h-captcha, #px-captcha, [data-sitekey]').find(
    (el) => !isHiddenOrForeign(el),
  );
  if (widget) return "captcha";
  const text = buildLines(root)
    .filter((l) => !l.hidden)
    .map((l) => l.text)
    .join("\n");
  if (text.length < 3000) {
    for (const [re, reason] of BLOCK_TEXT_RE) if (re.test(text)) return reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field picker + cross-field validation
// ---------------------------------------------------------------------------
function pick<T>(trace: Record<string, string>, field: string, ...candidates: Array<[T | null | undefined, string]>): T | null {
  for (const [value, source] of candidates) {
    if (value !== null && value !== undefined) {
      trace[field] = source;
      return value;
    }
  }
  return null;
}

export function crossValidate(p: ProductResponse, trace: Record<string, string>, errors: string[]) {
  if (p.listed_price !== null && p.mrp !== null && p.mrp < p.listed_price) {
    errors.push(`Validation: mrp (${p.mrp}) < listed_price (${p.listed_price}); discarding mrp.`);
    p.mrp = null;
    delete trace["mrp"];
  }
  if (p.discount_percent !== null && p.mrp && p.listed_price !== null) {
    const expected = Math.round(((p.mrp - p.listed_price) / p.mrp) * 100);
    if (Math.abs(expected - Math.round(p.discount_percent)) > 2) {
      errors.push(
        `Validation: discount_percent (${p.discount_percent}) does not match expected (${expected}%); discarding.`,
      );
      p.discount_percent = null;
      delete trace["discount_percent"];
    }
  }
  if (p.price_with_offers !== null && p.listed_price !== null && p.price_with_offers > p.listed_price) {
    errors.push(
      `Validation: price_with_offers (${p.price_with_offers}) > listed_price (${p.listed_price}); discarding.`,
    );
    p.price_with_offers = null;
    delete trace["price_with_offers"];
  }
  if (p.mrp !== null && p.listed_price !== null) {
    p.discount_amount = Math.round((p.mrp - p.listed_price) * 100) / 100;
    trace["discount_amount"] ??= "derived:mrp-listed_price";
    if (p.discount_percent === null && p.mrp > 0) {
      p.discount_percent = Math.round((p.discount_amount / p.mrp) * 100 * 100) / 100;
      trace["discount_percent"] = "derived:(mrp-listed)/mrp*100";
    }
  }
}

// ---------------------------------------------------------------------------
// Extraction from HTML
// ---------------------------------------------------------------------------
export function extractProductFromHtml(html: string, url: string): ProductResponse {
  const p = emptyProduct(url);
  const errors: string[] = [];
  const trace: Record<string, string> = {};
  const root = parse(html ?? "", { comment: false });

  const allLines = buildLines(root);
  const bodyLow = allLines.map((l) => l.text).join("\n").toLowerCase();

  try {
    // ---- Layer 1: structured -------------------------------------------
    const ld = parseJsonLd(collectLdBlocks(root));
    const embedded = extractEmbeddedState(safeQueryAll(root, "script").map((s) => s.rawText));
    const meta = metaMap(root);
    const metaData: Structured = {
      image_url: meta["og:image"] ?? meta["twitter:image"],
      brand: meta["product:brand"] ?? meta["og:brand"],
      listed_price: asNum(meta["product:price:amount"]) ?? undefined,
      currency: meta["product:price:currency"],
      availability: meta["product:availability"],
    };
    const ogTitle = meta["og:title"] ?? meta["twitter:title"] ?? null;

    const canonical = safeQueryAll(root, 'link[rel="canonical"]')[0]?.getAttribute("href")?.trim();
    if (canonical && !isDisallowedUrl(canonical)) {
      p.canonical_url = canonical;
      trace["canonical_url"] = "structured:canonical_link";
    }

    // ---- Layer 2: main product section ----------------------------------
    const visible = allLines.filter((l) => !l.hidden && !l.inOtherProduct);
    const zone = mainZone(visible, ld.title ?? embedded.title ?? null);
    const main = zone.lines;
    const mainText = main.map((l) => l.text);
    const mainJoined = mainText.join("\n");
    const zoneTag = zone.scope === "main" ? "main" : "page";

    const h1Text = main.filter((l) => l.inH1).map((l) => l.text).join(" ").replace(/\s+/g, " ").trim() || null;
    const structuredTitle = validateStr(ld.title ?? embedded.title);
    p.title = pick(
      trace,
      "title",
      [h1Text && structuredTitle && norm(h1Text).startsWith(norm(structuredTitle)) ? h1Text : null, "dom:h1(matches structured name)"],
      [structuredTitle, ld.title ? "structured:json_ld" : "structured:embedded"],
      [validateStr(h1Text), "dom:h1"],
      [validateStr(domFirstText(root, "title")), "dom:fallback"],
      [ogTitle && !/^online shopping india/i.test(ogTitle) ? validateStr(ogTitle) : null, "structured:meta"],
    );

    // Listed price
    const semanticPriceIdx = findPriceIndex(main, null);
    p.listed_price = pick(
      trace,
      "listed_price",
      [validatePrice(ld.listed_price), "structured:json_ld"],
      [validatePrice(embedded.listed_price), "structured:embedded"],
      [validatePrice(metaData.listed_price), "structured:meta"],
      [semanticPriceIdx >= 0 ? validatePrice(main[semanticPriceIdx]!.text) : null, `semantic:${zoneTag}_price`],
      [validatePrice(domFirstText(root, "listed_price")), "dom:fallback"],
    );
    const priceIdx = findPriceIndex(main, p.listed_price);
    const priceRow = near(main, priceIdx, 4, zone.titleEnd);

    // MRP: only a clearly displayed higher price (struck through or labelled MRP).
    const strikeLine = priceRow.find((l) => l.strike && PRICE_LIKE_RE.test(l.text));
    const mrpLabel = mainJoined.match(/\b(?:mrp|maximum retail price)\b[^\d₹\n]{0,12}₹?\s*([\d,]+(?:\.\d+)?)/i);
    p.mrp = pick(
      trace,
      "mrp",
      [validatePrice(ld.mrp), "structured:json_ld"],
      [validatePrice(embedded.mrp), "structured:embedded"],
      [strikeLine ? validatePrice(strikeLine.text) : null, `dom:strikethrough_${zoneTag}`],
      [mrpLabel ? validatePrice(mrpLabel[1]) : null, "semantic:mrp_label"],
      [validatePrice(domFirstText(root, "mrp")), "dom:fallback"],
    );

    const pctLine = priceRow.find((l) => PERCENT_RE.test(l.text));
    const pctOff = mainJoined.match(/(\d{1,2})\s*%\s*off/i);
    p.discount_percent = pick(
      trace,
      "discount_percent",
      [validatePercent(embedded.discount_percent), "structured:embedded"],
      [pctLine ? validatePercent(pctLine.text.match(PERCENT_RE)![1]) : null, `semantic:${zoneTag}_percent`],
      [pctOff ? validatePercent(pctOff[1]) : null, "semantic:percent_off"],
      [validatePercent(parsePercent(domFirstText(root, "discount_percent"))), "dom:fallback"],
    );

    // Flipkart's own "Buy at ₹X" / "Lowest price for you" / "Price with offers ₹X".
    const buyAt = mainText.map((t) => t.match(/^buy at\s*₹\s*([\d,]+(?:\.\d+)?)$/i)).find(Boolean);
    const lowestIdx = mainText.findIndex((t) => /^lowest price for you$/i.test(t));
    const lowest = lowestIdx > 0 && PRICE_RE.test(mainText[lowestIdx - 1]!) ? mainText[lowestIdx - 1]! : null;
    const withOffers = mainJoined.match(/price\s*with\s*offers\s*[₹:.]?\s*([\d,]+)/i);
    p.price_with_offers = pick(
      trace,
      "price_with_offers",
      [validatePrice(embedded.price_with_offers), "structured:embedded"],
      [buyAt ? validatePrice(buyAt[1]) : null, "semantic:buy_at_label"],
      [validatePrice(lowest), "semantic:lowest_price_label"],
      [withOffers ? validatePrice(withOffers[1]) : null, "semantic:price_with_offers"],
    );

    // Image, brand, ids, currency
    p.image_url = pick(
      trace,
      "image_url",
      [normalizeImageUrl(validateStr(ld.image_url)), "structured:json_ld"],
      [normalizeImageUrl(validateStr(embedded.image_url)), "structured:embedded"],
      [normalizeImageUrl(validateStr(metaData.image_url)), "structured:meta"],
      [normalizeImageUrl(validateStr(domFirstAttr(root, "image", "src"))), "dom:fallback"],
    );
    p.brand = pick(
      trace,
      "brand",
      [validateStr(ld.brand), "structured:json_ld"],
      [validateStr(embedded.brand), "structured:embedded"],
      [validateStr(metaData.brand), "structured:meta"],
      [validateStr(domFirstText(root, "brand")), "dom:fallback"],
    );
    p.product_id = pick(trace, "product_id", [pidFromUrl(url), "url:pid_param"], [validateStr(ld.product_id), "structured:json_ld/sku"]);
    const currency = ld.currency ?? metaData.currency;
    if (currency) {
      p.currency = currency;
      trace["currency"] = ld.currency ? "structured:json_ld" : "structured:meta";
    }

    // Rating (right after the title on current pages)
    const afterTitle = main.slice(zone.titleEnd, zone.titleEnd + 3).map((l) => l.text);
    const ratingLine = afterTitle.find((t) => /^\d(?:\.\d)?$/.test(t));
    const countLine = afterTitle.map((t) => t.match(/^\|\s*([\d,]+)$/)).find(Boolean);
    const ratingsLabel = mainJoined.match(/([\d,]+)\s+ratings?\b/i);
    const reviewsLabel = mainJoined.match(/([\d,]+)\s+reviews?\b/i);
    p.rating = pick(
      trace,
      "rating",
      [validateRating(ld.rating), "structured:json_ld"],
      [validateRating(embedded.rating), "structured:embedded"],
      [zone.scope === "main" ? validateRating(ratingLine) : null, "semantic:rating_after_title"],
      [validateRating(parseFloatLoose(domFirstText(root, "rating"))), "dom:fallback"],
    );
    p.rating_count = pick(
      trace,
      "rating_count",
      [ld.rating_count ?? null, "structured:json_ld"],
      [embedded.rating_count ?? null, "structured:embedded"],
      [zone.scope === "main" && countLine ? parseIntLoose(countLine[1]) : null, "semantic:rating_count_after_title"],
      [ratingsLabel ? parseIntLoose(ratingsLabel[1]) : null, "semantic:count_label"],
      [parseIntLoose(domFirstText(root, "rating_count")), "dom:fallback"],
    );
    p.review_count = pick(
      trace,
      "review_count",
      [ld.review_count ?? null, "structured:json_ld"],
      [embedded.review_count ?? null, "structured:embedded"],
      [reviewsLabel ? parseIntLoose(reviewsLabel[1]) : null, "semantic:review_label"],
      [parseIntLoose(domFirstText(root, "review_count")), "dom:fallback"],
    );

    // Seller (from the seller block only)
    const sellerHit = findSeller(mainText);
    const domSellerSplit = splitSellerRating(domFirstText(root, "seller_name"));
    const domSeller = domSellerSplit.name;
    p.seller_name = pick(
      trace,
      "seller_name",
      [isPlausibleSellerName(ld.seller_name) ? validateStr(ld.seller_name) : null, "structured:json_ld"],
      [isPlausibleSellerName(embedded.seller_name) ? validateStr(embedded.seller_name) : null, "structured:embedded"],
      [sellerHit?.name, `semantic:seller_section_${zoneTag}`],
      [isPlausibleSellerName(domSeller) ? validateStr(domSeller) : null, "dom:fallback"],
    );
    p.seller_rating = pick(
      trace,
      "seller_rating",
      [p.seller_name && sellerHit && p.seller_name === sellerHit.name ? sellerHit.rating : null, "semantic:seller_section"],
      [p.seller_name && p.seller_name === domSeller ? domSellerSplit.rating : null, "dom:seller_name_suffix"],
      [p.seller_name ? validateRating(parseFloatLoose(domFirstText(root, "seller_rating"))) : null, "dom:fallback"],
    );

    // Delivery
    p.delivery_text = pick(
      trace,
      "delivery_text",
      [validateStr(embedded.delivery_text), "structured:embedded"],
      [findDelivery(mainText), "semantic:delivery_by"],
      [validateStr(domFirstText(root, "delivery_text")), "dom:fallback"],
    );

    // Availability
    const stockLine = main.find(
      (l) => !l.inLink && /^(hurry,? only.*|only \d+ left.*|sold out|currently unavailable.*|out of stock)$/i.test(l.text),
    );
    const buttonLine = mainText.find((t) => /^(add to cart|buy now|notify me|coming soon)$/i.test(t)) ?? null;
    p.stock_text = stockLine?.text ?? domFirstText(root, "stock_text");
    if (p.stock_text) trace["stock_text"] = stockLine ? `semantic:${zoneTag}_stock` : "dom:fallback";
    const structuredAvail = ld.availability ?? metaData.availability ?? embedded.availability ?? null;
    p.availability = mapAvailability(p.stock_text, buttonLine ?? domFirstText(root, "availability"), structuredAvail);
    if (p.availability) trace["availability"] = structuredAvail ? "structured:json_ld/meta" : "semantic:buttons";

    // ---- Offers ----------------------------------------------------------
    let offerSource = `semantic:offer_cards_${zoneTag}`;
    let offerInput: string[] = mainText;
    let explicit = false;
    for (const sel of SELECTORS.offers_container) {
      const containers = safeQueryAll(root, sel).filter((el) => !isHiddenOrForeign(el));
      if (!containers.length) continue;
      const lines = containers.flatMap((c) => visibleTextOf(c));
      if (lines.length) {
        offerInput = lines;
        explicit = true;
        offerSource = "dom:offers_container";
        break;
      }
    }
    const { cards, collapsed } = buildOfferCards(offerInput, explicit);
    p.raw_offers = cards.map(cardRaw).slice(0, 50);
    const classified = classifyCards(cards);
    p.bank_offers = classified.bank;
    p.coupon_offers = classified.coupons;
    p.exchange_offer = classified.exchange;
    if (p.bank_offers.length) trace["bank_offers"] = offerSource;
    if (p.coupon_offers.length) trace["coupon_offers"] = offerSource;
    if (p.exchange_offer) trace["exchange_offer"] = offerSource;
    if (p.raw_offers.length) trace["raw_offers"] = offerSource;
    for (const label of collapsed) {
      errors.push(`${label}: section is shown but its details are not rendered (requires interaction or loads later).`);
    }

    p.exchange_offer_text = p.exchange_offer?.max_exchange_value ?? null;
    const bankValue = p.bank_offers.map((b) => b.offer_value).find((v) => v && /₹/.test(v)) ?? null;
    p.bank_offer_text = bankValue ? (/off/i.test(bankValue) ? bankValue : `${bankValue} off`) : null;
    p.coupon_text = p.coupon_offers[0]?.raw?.replace(/^coupons?:\s*/i, "").slice(0, 200) ?? null;

    // SuperCoins (main section only, so header/footer links are ignored)
    p.supercoins = detectSupercoins(explicit ? [...new Set([...offerInput, ...mainText])].join("\n") : mainJoined);
    if (p.supercoins.text) trace["supercoins"] = `semantic:${zoneTag}_text`;

    p.effective_price_estimate = computeEffectivePrice(
      p.listed_price,
      p.bank_offers,
      p.coupon_offers,
      p.exchange_offer,
      p.supercoins,
    );
    if (p.effective_price_estimate !== null) {
      trace["effective_price_estimate"] = "computed:listed_price-best_flat_bank_offer-best_flat_coupon";
    } else if (p.bank_offers.length || p.coupon_offers.length || p.exchange_offer || p.supercoins.text) {
      errors.push(
        "Effective price estimate: offer eligibility unknown (conditions, ranges, exchange, SuperCoins or cashback); not estimated.",
      );
    }

    // ---- Specifications & variants ----------------------------------------
    const spec = extractSpecifications(root);
    p.specifications = spec.specs;
    if (spec.source) trace["specifications"] = spec.source;
    const hasMoreSpecs = mainText.some((t) => /^(all details|specifications)$/i.test(t));
    if (!spec.source) {
      errors.push("Specifications: section requires interaction or is not rendered.");
    } else if (spec.source === "dom:product_highlights" && hasMoreSpecs) {
      errors.push("Specifications: only the visible product highlights are returned; the full list requires interaction.");
    }

    const vr = extractVariants(root, visible, pidFromUrl(url));
    p.variants = vr.variants;
    if (vr.source) trace["variants"] = vr.source;
    else errors.push("Variants: none visible (section requires interaction or is not rendered).");
    for (const v of p.variants) {
      if (v.value) p.selected_variants[v.name ?? "variant"] = v.value;
    }
    if (Object.keys(p.selected_variants).length) trace["selected_variants"] = vr.source ?? "derived";

    // ---- Layer 4: cross-field validation ---------------------------------
    crossValidate(p, trace, errors);

    // ---- Missing-field notes (null, never guessed) -----------------------
    const needsLocation = LOCATION_HINT_RE.test(mainJoined);
    if (p.title === null) errors.push("Could not extract product title.");
    if (p.listed_price === null) errors.push("Could not extract listed price.");
    if (p.mrp === null) errors.push("MRP not visible on current page state.");
    if (p.seller_name === null) {
      errors.push(needsLocation ? "Seller requires delivery location selection." : "Seller not visible on current page state.");
    }
    if (p.delivery_text === null) {
      errors.push(
        needsLocation ? "Delivery date requires delivery location selection." : "Could not extract delivery text.",
      );
    }

    // ---- Why each empty field is empty ------------------------------------
    const collapsedCats = new Set(collapsed.map((l) => offerCategory(l)));
    const status = p.field_status;
    const empty = (v: unknown) =>
      v === null || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
    const STATUS_FIELDS = [
      "title", "listed_price", "mrp", "discount_percent", "discount_amount", "price_with_offers",
      "effective_price_estimate", "image_url", "rating", "rating_count", "review_count", "seller_name",
      "seller_rating", "delivery_text", "availability", "bank_offers", "coupon_offers", "exchange_offer",
      "specifications", "variants",
    ] as const;
    for (const f of STATUS_FIELDS) if (empty(p[f])) status[f] = "missing";
    if (needsLocation) {
      if (p.seller_name === null) status["seller_name"] = "location_required";
      if (p.seller_rating === null && p.seller_name === null) status["seller_rating"] = "location_required";
      if (p.delivery_text === null) status["delivery_text"] = "location_required";
    }
    if (p.bank_offers.length === 0 && collapsedCats.has("bank")) status["bank_offers"] = "hidden";
    if (p.coupon_offers.length === 0 && collapsedCats.has("coupon")) status["coupon_offers"] = "hidden";
    if (!p.exchange_offer && collapsedCats.has("exchange")) status["exchange_offer"] = "hidden";
    if (!spec.source && hasMoreSpecs) status["specifications"] = "interaction_required";
    if (p.effective_price_estimate === null && (p.bank_offers.length || p.coupon_offers.length || p.exchange_offer)) {
      status["effective_price_estimate"] = "eligibility_unknown";
    }
  } catch (e) {
    errors.push(`Unexpected extraction error: ${(e as Error).message}`);
  }

  // ---- Block / 404 detection -------------------------------------------
  if (bodyLow.includes("page not found") && p.title === null) {
    throw new FlipkartNotFoundError("Product page not found.");
  }
  if (/\b404\b/.test(bodyLow) && p.title === null && p.listed_price === null) {
    throw new FlipkartNotFoundError("Product page not found.");
  }
  if (bodyLow.includes("access denied") || bodyLow.includes("are you a robot") || bodyLow.includes("captcha")) {
    throw new FlipkartBlockedError("Flipkart is showing a CAPTCHA / access-denied page. Not bypassing it.", { reason: "captcha" });
  }

  p.extraction_trace = trace;
  p.errors = errors;
  return p;
}
