// Fixture tests: real Flipkart watch pages (captured Nov 2026, styles and app scripts
// stripped, DOM and inline styles kept) plus the original project's Acer sample page.
// No network needed, so selector changes can be checked without hitting Flipkart.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { extractProductFromHtml, findSeller } from "./extract";
import { isDisallowedUrl, isPlausibleSellerName, mentionsDisallowedPath } from "./parse";

const fixture = (name: string) => readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");

const GREY_URL =
  "https://www.flipkart.com/timex-grey-dial-analog-watch-men/p/itm78801e858d566?pid=WATHH3X5F8EGSQBG";
const SILVER_URL =
  "https://www.flipkart.com/timex-silver-dial-analog-watch-men/p/itm516ef53960726?pid=WATHH3X5FYYDF2JY";
const ACER_URL =
  "https://www.flipkart.com/acer-aspire-3-intel-celeron-dual-core-8-gb-512-gb-ssd-windows-11-home-a311-45-thin-light-laptop" +
  "/p/itmad38595c5a902?pid=COMH7NCZY2QDJ5Z4";

const grey = extractProductFromHtml(fixture("timex-grey-watch-in-stock.html"), GREY_URL);
const silver = extractProductFromHtml(fixture("timex-silver-watch-out-of-stock.html"), SILVER_URL);
const acer = extractProductFromHtml(fixture("acer-aspire3-sample.html"), ACER_URL);

describe("real watch page (in stock)", () => {
  it("reads the MRP from the struck-through price next to the selling price", () => {
    expect(grey.listed_price).toBe(1729);
    expect(grey.mrp).toBe(3195);
    expect(grey.extraction_trace["mrp"]).toBe("dom:strikethrough_main");
  });
  it("derives the discount amount once MRP is known", () => {
    expect(grey.discount_percent).toBe(46);
    expect(grey.discount_amount).toBe(1466);
  });
  it("reads Flipkart's own 'Buy at' price as price_with_offers", () => {
    expect(grey.price_with_offers).toBe(1383);
  });
  it("takes the seller from the seller block, not the header's 'Advertise' link", () => {
    expect(grey.seller_name).toBe("RetailNet");
    expect(grey.seller_rating).toBe(4.5);
  });
  it("joins the split delivery line", () => {
    expect(grey.delivery_text).toBe("Delivery by 12 Nov, Thu");
  });
  it("extracts the visible coupon card and keeps its original text", () => {
    expect(grey.coupon_offers).toHaveLength(1);
    expect(grey.coupon_offers[0]!.coupon_value).toBe("₹173 off");
    expect(grey.raw_offers).toEqual(["Coupons: ₹173 off | Save 10% extra up to ₹300 on 10 item(s)"]);
  });
  it("does not treat the hidden bank-offer layer as available", () => {
    expect(grey.bank_offers).toEqual([]);
    expect(grey.errors.some((e) => e.startsWith("Bank offers:"))).toBe(true);
  });
  it("reads the selected variants", () => {
    expect(grey.variants).toEqual([
      { name: "Strap Color", value: "Blue", options: [] },
      { name: "Dial Color", value: "Grey, Rose Gold", options: [] },
    ]);
  });
  it("uses ratingCount for ratings and reviewCount for reviews", () => {
    expect(grey.rating).toBe(4);
    expect(grey.rating_count).toBe(371);
    expect(grey.review_count).toBe(24);
  });
  it("reports missing specs instead of guessing", () => {
    expect(grey.specifications).toEqual({});
    expect(grey.errors).toContain("Specifications: section requires interaction or is not rendered.");
  });

  it("ignores carousel prices when structured data is missing", () => {
    const noLd = fixture("timex-grey-watch-in-stock.html").replace(/<script[^>]*ld\+json[^>]*>[\s\S]*?<\/script>/g, "");
    const p = extractProductFromHtml(noLd, GREY_URL);
    expect(p.listed_price).toBe(1729); // first ₹ price on the page is an ad at ₹1,549
    expect(p.mrp).toBe(3195);
    expect(p.seller_name).toBe("RetailNet");
  });
});

describe("real watch page (out of stock)", () => {
  it("core fields", () => {
    expect(silver.title).toBe("TIMEX Silver Dial Analog Watch - For Men TWEG356SMU01T");
    expect(silver.listed_price).toBe(1739);
    expect(silver.mrp).toBe(2995);
    expect(silver.discount_percent).toBe(42);
    expect(silver.discount_amount).toBe(1256);
    expect(silver.availability).toBe("OUT_OF_STOCK");
    expect(silver.seller_name).toBe("RetailNet");
    expect(silver.canonical_url).toBe(
      "https://www.flipkart.com/timex-silver-dial-analog-watch-men/p/itm516ef53960726",
    );
  });
  it("returns the visible product highlights as specifications", () => {
    expect(silver.specifications).toEqual({
      "Display Type": "Analog",
      Occasion: "Formal",
      Diameter: "40 mm",
      "Dial Color": "Silver",
    });
  });
  it("explains a missing delivery date", () => {
    expect(silver.delivery_text).toBeNull();
    expect(silver.errors).toContain("Delivery date requires delivery location selection.");
  });
});

describe("Acer sample page (original project fixture)", () => {
  it("prices", () => {
    expect(acer.listed_price).toBe(29990);
    expect(acer.mrp).toBe(46999);
    expect(acer.discount_percent).toBe(36);
    expect(acer.discount_amount).toBe(17009);
    expect(acer.price_with_offers).toBe(27065);
  });
  it("offers", () => {
    expect(acer.exchange_offer_text).toBe("Up to ₹24,500");
    expect(acer.bank_offer_text).toBe("₹2,925 off");
    expect(acer.coupon_text).toBe("Unlock Acer coupon • ₹1000 off");
    expect(acer.bank_offers[0]!.bank_name).toBe("Axis");
    expect(acer.exchange_offer?.max_exchange_value).toBe("Up to ₹24,500");
    for (const b of acer.bank_offers) expect(b.title?.toLowerCase()).not.toBe("bank offer");
  });
  it("seller, delivery, ratings", () => {
    expect(acer.seller_name).toBe("TBL Online");
    expect(acer.delivery_text).toBe("Delivery by Wednesday, 21 Oct");
    expect(acer.rating).toBe(3.7);
    expect(acer.rating_count).toBe(10277);
    expect(acer.review_count).toBe(1049);
  });
  it("structured fields", () => {
    expect(acer.brand).toBe("ACER");
    expect(acer.product_id).toBe("COMH7NCZY2QDJ5Z4");
    expect(acer.currency).toBe("INR");
    expect(acer.availability).toBe("IN_STOCK");
    expect(acer.specifications["Processor"]).toBe("Intel Celeron Dual Core");
    expect(acer.variants.length).toBeGreaterThanOrEqual(1);
    expect(acer.supercoins.earn).toBe("Earn 500 SuperCoins");
  });
  it("records a source for each field", () => {
    for (const k of ["listed_price", "seller_name", "delivery_text", "product_id", "canonical_url"]) {
      expect(acer.extraction_trace[k]).toBeTruthy();
    }
  });
});

describe("no fabrication", () => {
  it("minimal page gives nulls and notes", () => {
    const p = extractProductFromHtml(
      "<html><head><title>Some Product</title></head><body><h1>Some Product</h1></body></html>",
      "https://www.flipkart.com/some/p/itm123",
    );
    expect(p.listed_price).toBeNull();
    expect(p.mrp).toBeNull();
    expect(p.seller_name).toBeNull();
    expect(p.errors).toContain("MRP not visible on current page state.");
    expect(p.errors).toContain("Could not extract listed price.");
  });
  it("empty page gives no offers", () => {
    const p = extractProductFromHtml("", "https://www.flipkart.com/x/p/itm1");
    expect(p.title).toBeNull();
    expect(p.bank_offers).toEqual([]);
    expect(p.coupon_offers).toEqual([]);
    expect(p.exchange_offer).toBeNull();
    expect(p.raw_offers).toEqual([]);
  });
  it("discards an MRP lower than the selling price", () => {
    const p = extractProductFromHtml(
      `<html><head><script type="application/ld+json">{"@type":"Product","name":"Test","offers":{"price":"5000","priceSpecification":{"maxPrice":"3000"}}}</script></head><body>Test</body></html>`,
      "https://www.flipkart.com/x/p/itm1",
    );
    expect(p.mrp).toBeNull();
    expect(p.errors.some((e) => e.includes("mrp") && e.includes("listed_price"))).toBe(true);
  });
  it("discards a price-with-offers above the selling price", () => {
    const p = extractProductFromHtml(
      `<html><head><script type="application/ld+json">{"@type":"Product","name":"Test","offers":{"price":"5000"}}</script></head><body><div>Price with offers ₹99999</div></body></html>`,
      "https://www.flipkart.com/x/p/itm1",
    );
    expect(p.listed_price).toBe(5000);
    expect(p.price_with_offers).toBeNull();
  });
  it("drops offer lines that point at disallowed paths", () => {
    const p = extractProductFromHtml(
      `<html><body><div data-testid="offers"><div>Bank Offer ₹500 off</div><div>See /offer-details for more</div><div>Go to /seller-details</div></div></body></html>`,
      "https://www.flipkart.com/x/p/itm1",
    );
    for (const line of p.raw_offers) expect(mentionsDisallowedPath(line)).toBe(false);
  });
});

describe("seller rules", () => {
  it("rejects navigation labels and numbers as seller names", () => {
    expect(isPlausibleSellerName("Advertise")).toBe(false);
    expect(isPlausibleSellerName("4.5")).toBe(false);
    expect(isPlausibleSellerName("10 years with Flipkart")).toBe(false);
    expect(isPlausibleSellerName("TitanCompanyLtd")).toBe(true);
  });
  it("reads the older 'Seller' label layout", () => {
    expect(findSeller(["Seller", "TitanCompanyLtd", "4.2", "10 days return policy"])).toEqual({
      name: "TitanCompanyLtd",
      rating: 4.2,
    });
  });
  it("skips 'Become a Seller' followed by 'Advertise'", () => {
    expect(findSeller(["Become a Seller", "Advertise", "More"])).toBeNull();
  });
});

describe("disallowed paths", () => {
  it("blocks paths robots.txt disallows", () => {
    expect(isDisallowedUrl("https://www.flipkart.com/offer-details?x=1")).toBe(true);
    expect(isDisallowedUrl("https://www.flipkart.com/sellers?pid=X")).toBe(true);
    expect(isDisallowedUrl("https://www.flipkart.com/x/p/itm1?colorSelected=red")).toBe(true);
    expect(isDisallowedUrl("https://www.flipkart.com/login?ret=/x")).toBe(true);
    expect(isDisallowedUrl("https://www.flipkart.com/acer-laptop/p/itm123?pid=ABC")).toBe(false);
  });
});
