// Ported from the original pytest suite (tests/test_api.py).
import { describe, expect, it, vi } from "vitest";

import { handleDebugRequest, handleProductRequest } from "./api";
import { computeEffectivePrice, detectSupercoins, isFlipkartProductUrl, parsePercent, parsePrice } from "./parse";
import { extractProductFromHtml, FlipkartBlockedError, FlipkartNotFoundError } from "./scraper";
import { emptyProduct, emptySuperCoins } from "./types";

const req = (url?: string) =>
  new Request(
    url === undefined
      ? "http://localhost/api/public/product"
      : `http://localhost/api/public/product?url=${encodeURIComponent(url)}`,
  );
const settings = { requestTimeoutSeconds: 5, userAgent: null };

describe("URL validation", () => {
  it.each([
    "not-a-url",
    "https://www.amazon.com/dp/B0XYZ",
    "https://www.flipkart.com/search?q=laptop",
    "https://www.flipkart.com/",
    "https://example.com/apple-iphone-16/p/itmb07d67f995271",
  ])("rejects %s with 400 INVALID_URL", async (url) => {
    const scrape = vi.fn();
    const res = await handleProductRequest(req(url), { scrape, settings });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_URL");
    expect(scrape).not.toHaveBeenCalled();
  });

  it.each([
    "https://www.flipkart.com/apple-iphone-16-black-128-gb/p/itmb07d67f995271?pid=MOBH4DQFG8NKFRDY",
    "https://www.flipkart.com/some-product/p/itmabc123",
  ])("accepts %s", async (url) => {
    const scrape = vi.fn().mockResolvedValue({ ...emptyProduct(url), title: "Mock" });
    const res = await handleProductRequest(req(url), { scrape, settings });
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe("Mock");
  });

  it("rejects product URLs on paths robots.txt disallows", async () => {
    const scrape = vi.fn();
    const res = await handleProductRequest(req("https://www.flipkart.com/x/p/itm1?pid=A&colorSelected=red"), { scrape, settings });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_URL");
    expect(scrape).not.toHaveBeenCalled();
  });

  it("returns 422 when url is missing", async () => {
    const res = await handleProductRequest(req(), { scrape: vi.fn(), settings });
    expect(res.status).toBe(422);
  });

  it("isFlipkartProductUrl", () => {
    expect(isFlipkartProductUrl("https://www.flipkart.com/x/p/itm123")).toBe(true);
    expect(isFlipkartProductUrl("https://www.flipkart.com/search?q=x")).toBe(false);
    expect(isFlipkartProductUrl("https://amazon.com/x/p/123")).toBe(false);
    expect(isFlipkartProductUrl("not a url")).toBe(false);
  });
});

describe("error contract", () => {
  const url = "https://www.flipkart.com/x/p/itmxxx";
  it("maps not-found to 404 PRODUCT_NOT_FOUND", async () => {
    const scrape = vi.fn().mockRejectedValue(new FlipkartNotFoundError("nope"));
    const res = await handleProductRequest(req(url), { scrape, settings });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("PRODUCT_NOT_FOUND");
  });
  it("maps blocks to 503 FLIPKART_BLOCKED", async () => {
    const scrape = vi.fn().mockRejectedValue(new FlipkartBlockedError("captcha"));
    const res = await handleProductRequest(req(url), { scrape, settings });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("FLIPKART_BLOCKED");
  });
  it("maps anything else to 500 INTERNAL_ERROR", async () => {
    const scrape = vi.fn().mockRejectedValue(new Error("boom"));
    const res = await handleProductRequest(req(url), { scrape, settings });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("INTERNAL_ERROR");
  });
});

describe("debug endpoint", () => {
  const dreq = (url: string) => new Request(`http://localhost/api/public/debug?url=${encodeURIComponent(url)}`);
  const url = "https://www.flipkart.com/x/p/itm1?pid=P1";
  const html = `<html><body><h1>Thing</h1><div>₹500</div></body></html>`;
  it("returns trace and errors, without HTML unless DEBUG_SAVE_HTML is on", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ html, finalUrl: url });
    const body = await (await handleDebugRequest(dreq(url), { fetchPage, settings })).json();
    expect(body.status).toBe("ok");
    expect(body.extraction_trace.listed_price).toBe("semantic:main_price");
    expect(body.saved_html).toBeNull();
    expect(body.html).toBeUndefined();
  });
  it("includes the page HTML when DEBUG_SAVE_HTML is on", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ html, finalUrl: url });
    const body = await (
      await handleDebugRequest(dreq(url), { fetchPage, settings: { ...settings, debugSaveHtml: true } })
    ).json();
    expect(body.html).toBe(html);
  });
  it("reports blocks without a product", async () => {
    const fetchPage = vi.fn().mockRejectedValue(new FlipkartBlockedError("HTTP 429"));
    const body = await (await handleDebugRequest(dreq(url), { fetchPage, settings })).json();
    expect(body.status).toBe("blocked");
    expect(body.product).toBeNull();
  });
});

describe("helpers", () => {
  it("parsePrice", () => {
    expect(parsePrice("₹29,990")).toBe(29990);
    expect(parsePrice("46999")).toBe(46999);
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice("abc")).toBeNull();
  });
  it("parsePercent", () => {
    expect(parsePercent("36% off")).toBe(36);
    expect(parsePercent("15%")).toBe(15);
    expect(parsePercent(null)).toBeNull();
  });
  it("effective price never subtracts 'Up to' ranges", () => {
    const est = computeEffectivePrice(
      27990,
      [{ title: null, offer_value: "₹1,000", bank_name: "Axis", offer_type: "card offer", raw: null }],
      [],
      { title: null, max_exchange_value: "Up to ₹12,000", exchange_condition: null, raw: null },
      emptySuperCoins(),
    );
    expect(est).toBe(26990);
  });
  it("effective price ignores 'upto' ranges and EMI plans", () => {
    const est = computeEffectivePrice(
      2000,
      [
        { title: null, offer_value: "₹100 off", bank_name: "Axis", offer_type: "card offer", raw: null },
        { title: null, offer_value: "₹88", bank_name: null, offer_type: "EMI offer", raw: null },
      ],
      [{ title: null, coupon_value: "upto ₹500", coupon_code: null, applicable_condition: null, raw: null }],
      null,
      emptySuperCoins(),
    );
    expect(est).toBe(1900);
  });
  it("detects SuperCoins", () => {
    const sc = detectSupercoins("Some text\nEarn 500 SuperCoins\nMore text");
    expect(sc.earn).toBe("Earn 500 SuperCoins");
    expect(sc.text).not.toBeNull();
    expect(detectSupercoins("Nothing here").earn).toBeNull();
  });
});

describe("extractProductFromHtml", () => {
  const url = "https://www.flipkart.com/acer-aspire-3/p/itmad38595c5a902?pid=COMH7NCZY2QDJ5Z4";
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">[{"@context":"https://schema.org","@type":"Product","name":"Acer Aspire 3","brand":{"@type":"Brand","name":"ACER"},"image":"https://rukminim2.flixcart.com/image/a.jpg","offers":{"@type":"Offer","price":27990,"priceCurrency":"INR","availability":"http://schema.org/InStock"},"aggregateRating":{"@type":"AggregateRating","ratingValue":4.2,"ratingCount":1500,"reviewCount":300}}]</script>
    </head><body>
      <h1><span class="VU-ZEz">Acer Aspire 3 Intel Celeron</span></h1>
      <div class="Nx9bqQ CxhGGd">₹27,990</div>
      <div class="yRaY8b">₹32,990</div>
      <div class="_17Bz-0">
        <div>10% Instant Discount on Axis Bank Credit Card</div>
        <div>Exchange Offer up to ₹12,000</div>
      </div>
      <div>Earn 500 SuperCoins</div>
      <table><tr><td>RAM</td><td>8 GB</td></tr></table>
    </body></html>`;

  it("extracts core fields, offers and derived values", () => {
    const p = extractProductFromHtml(html, url);
    expect(p.title).toBe("Acer Aspire 3 Intel Celeron");
    expect(p.brand).toBe("ACER");
    expect(p.product_id).toBe("COMH7NCZY2QDJ5Z4");
    expect(p.listed_price).toBe(27990);
    expect(p.mrp).toBe(32990);
    expect(p.discount_amount).toBe(5000);
    expect(p.rating).toBe(4.2);
    expect(p.rating_count).toBe(1500);
    expect(p.availability).toBe("IN_STOCK");
    expect(p.bank_offers[0]?.bank_name).toBe("Axis");
    expect(p.exchange_offer?.max_exchange_value).toBe("up to ₹12,000");
    expect(p.supercoins.earn).toBe("Earn 500 SuperCoins");
    expect(p.specifications).toEqual({ RAM: "8 GB" });
  });

  it("flags CAPTCHA pages as blocked", () => {
    expect(() =>
      extractProductFromHtml("<html><body><h1>Are you a robot?</h1></body></html>", url),
    ).toThrow(FlipkartBlockedError);
  });
});
