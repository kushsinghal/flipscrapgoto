// Response shapes for the Flipkart Product Details API.
// Field names stay snake_case so existing callers of the original API keep working.

export interface BankOffer {
  title: string | null;
  offer_value: string | null;
  bank_name: string | null;
  offer_type: string | null; // card offer | EMI offer | cashback
  raw: string | null;
}

export interface CouponOffer {
  title: string | null;
  coupon_value: string | null;
  coupon_code: string | null;
  applicable_condition: string | null;
  raw: string | null;
}

export interface ExchangeOffer {
  title: string | null;
  max_exchange_value: string | null;
  exchange_condition: string | null;
  raw: string | null;
}

export interface SuperCoins {
  /** Visible line that states coins earned on this purchase (must contain a number). */
  earn: string | null;
  /** Visible line that states coins usable on this purchase (must contain a number). */
  redeem: string | null;
  text: string | null;
  /** True only when the page explicitly advertises 100% back. Never inferred. */
  advertised_full_back: boolean;
}

export interface Variant {
  name: string | null;
  value: string | null;
  options: string[];
}

export interface ProductResponse {
  status: "ok";
  title: string | null;
  brand: string | null;
  product_id: string | null;
  listed_price: number | null;
  mrp: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  price_with_offers: number | null;
  currency: string | null;
  availability: string | null;
  stock_text: string | null;
  seller_name: string | null;
  seller_rating: number | null;
  delivery_text: string | null;
  product_url: string | null;
  canonical_url: string | null;
  image_url: string | null;
  rating: number | null;
  rating_count: number | null;
  review_count: number | null;
  /** Each variant's `value` is the selected one and `options` the available ones. */
  variants: Variant[];
  /** Selected value per variant name, e.g. { "Dial Color": "Silver" }. Never filled from options. */
  selected_variants: Record<string, string>;
  specifications: Record<string, string>;
  bank_offers: BankOffer[];
  coupon_offers: CouponOffer[];
  exchange_offer: ExchangeOffer | null;
  exchange_offer_text: string | null;
  bank_offer_text: string | null;
  coupon_text: string | null;
  supercoins: SuperCoins;
  effective_price_estimate: number | null;
  raw_offers: string[];
  /** Which extraction layer produced each field (e.g. "structured:json_ld", "dom:strikethrough_main"). */
  extraction_trace: Record<string, string>;
  /** Why an empty field is empty. Only empty fields appear here. */
  field_status: Record<string, FieldStatus>;
  scraped_at: string;
  fetched_at: string;
  errors: string[];
}

export type FieldStatus =
  | "missing" // not on the page
  | "hidden" // on the page but in a hidden/collapsed layer, so not used
  | "location_required" // needs a delivery location (pincode) first
  | "interaction_required" // behind a tab/button that isn't opened automatically
  | "eligibility_unknown"; // offers exist but whether they apply can't be known

export type ApiErrorCode =
  | "INVALID_URL"
  | "PRODUCT_NOT_FOUND"
  | "FLIPKART_BLOCKED"
  | "INTERNAL_ERROR"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "NOT_FOUND";

export interface ErrorResponse {
  status: "error";
  error: ApiErrorCode | string;
  detail: string | null;
}

export function emptySuperCoins(): SuperCoins {
  return { earn: null, redeem: null, text: null, advertised_full_back: false };
}

export function emptyProduct(url: string | null = null): ProductResponse {
  return {
    status: "ok",
    title: null,
    brand: null,
    product_id: null,
    listed_price: null,
    mrp: null,
    discount_percent: null,
    discount_amount: null,
    price_with_offers: null,
    currency: "INR",
    availability: null,
    stock_text: null,
    seller_name: null,
    seller_rating: null,
    delivery_text: null,
    product_url: url,
    canonical_url: null,
    image_url: null,
    rating: null,
    rating_count: null,
    review_count: null,
    variants: [],
    selected_variants: {},
    specifications: {},
    bank_offers: [],
    coupon_offers: [],
    exchange_offer: null,
    exchange_offer_text: null,
    bank_offer_text: null,
    coupon_text: null,
    supercoins: emptySuperCoins(),
    effective_price_estimate: null,
    raw_offers: [],
    extraction_trace: {},
    field_status: {},
    scraped_at: new Date().toISOString(),
    fetched_at: new Date().toISOString(),
    errors: [],
  };
}
