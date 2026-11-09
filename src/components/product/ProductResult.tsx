import { useState, type ReactNode } from "react";
import { BadgePercent, Banknote, ChevronDown, Coins, Repeat, Star, Store, Truck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ProductResponse } from "@/lib/flipkart/types";

const inr = (n: number | null | undefined, currency = "INR") =>
  n === null || n === undefined
    ? "—"
    : new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: currency || "INR",
        minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(n);

const AVAILABILITY: Record<string, { label: string; className: string }> = {
  IN_STOCK: { label: "In stock", className: "bg-success text-success-foreground border-transparent" },
  OUT_OF_STOCK: { label: "Out of stock", className: "bg-destructive text-destructive-foreground border-transparent" },
  PREORDER: { label: "Coming soon", className: "bg-warning text-warning-foreground border-transparent" },
};

function Field({ icon: Icon, label, value }: { icon: typeof Star; label: string; value: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="mt-0.5 break-words text-sm">{value ?? "—"}</div>
      </div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="rule-dashed pt-6">
      <h3 className="mb-4 flex items-baseline gap-2 font-display text-2xl">
        {title}
        {count !== undefined && <span className="tabular text-sm text-muted-foreground">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

export function ProductResult({ product }: { product: ProductResponse }) {
  const [showJson, setShowJson] = useState(false);
  const avail = product.availability ? AVAILABILITY[product.availability] : null;
  const specs = Object.entries(product.specifications);
  const offerCount =
    product.bank_offers.length + product.coupon_offers.length + (product.exchange_offer ? 1 : 0);

  return (
    <article className="animate-rise rounded-lg border bg-card p-6 text-card-foreground shadow-card sm:p-8">
      <div className="grid gap-8 md:grid-cols-[200px_1fr]">
        <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md border bg-background p-3">
          {product.image_url ? (
            <img src={product.image_url} alt={product.title ?? "Product"} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-xs text-muted-foreground">No image found</span>
          )}
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {product.brand && <Badge variant="outline">{product.brand}</Badge>}
            {avail && <Badge className={avail.className}>{avail.label}</Badge>}
            {product.product_id && (
              <span className="tabular text-xs text-muted-foreground">{product.product_id}</span>
            )}
          </div>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">
            {product.title ?? "Untitled product"}
          </h2>

          <div className="mt-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="tabular text-3xl font-medium">{inr(product.listed_price, product.currency ?? "INR")}</span>
            {product.mrp && product.mrp !== product.listed_price && (
              <span className="tabular text-muted-foreground line-through">{inr(product.mrp)}</span>
            )}
            {product.discount_percent !== null && (
              <span className="tabular rounded-sm bg-highlight px-1.5 py-0.5 text-sm font-medium">
                {product.discount_percent}% off
              </span>
            )}
          </div>
          {product.price_with_offers !== null && (
            <p className="mt-2 text-sm text-muted-foreground">
              Flipkart shows <span className="tabular font-medium text-foreground">{inr(product.price_with_offers)}</span> with
              offers applied
            </p>
          )}
          {product.effective_price_estimate !== null && (
            <p className="mt-2 text-sm text-muted-foreground">
              About <span className="tabular font-medium text-foreground">{inr(product.effective_price_estimate)}</span> after
              offers (estimate)
            </p>
          )}

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <Field
              icon={Star}
              label="Rating"
              value={
                product.rating !== null ? (
                  <span className="tabular">
                    {product.rating} ★
                    {product.rating_count !== null && ` · ${product.rating_count.toLocaleString("en-IN")} ratings`}
                    {product.review_count !== null && ` · ${product.review_count.toLocaleString("en-IN")} reviews`}
                  </span>
                ) : null
              }
            />
            <Field
              icon={Store}
              label="Seller"
              value={
                product.seller_name
                  ? `${product.seller_name}${product.seller_rating !== null ? ` · ${product.seller_rating} ★` : ""}`
                  : null
              }
            />
            <Field icon={Truck} label="Delivery" value={product.delivery_text} />
            <Field icon={BadgePercent} label="Stock note" value={product.stock_text} />
          </div>
        </div>
      </div>

      <div className="mt-8 space-y-8">
        {offerCount > 0 || product.supercoins.text ? (
          <Section title="Offers" count={offerCount}>
            <ul className="space-y-3">
              {product.bank_offers.map((o, i) => (
                <li key={`b${i}`} className="flex gap-3 text-sm">
                  <Banknote className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    {o.title}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {[o.offer_type, o.bank_name, o.offer_value].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </li>
              ))}
              {product.coupon_offers.map((o, i) => (
                <li key={`c${i}`} className="flex gap-3 text-sm">
                  <BadgePercent className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    {o.title}
                    {o.coupon_code && <code className="tabular ml-2 rounded-sm bg-muted px-1.5 py-0.5 text-xs">{o.coupon_code}</code>}
                    {o.applicable_condition && (
                      <span className="ml-2 text-xs text-muted-foreground">{o.applicable_condition}</span>
                    )}
                  </span>
                </li>
              ))}
              {product.exchange_offer && (
                <li className="flex gap-3 text-sm">
                  <Repeat className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{product.exchange_offer.title}</span>
                </li>
              )}
              {product.supercoins.text && (
                <li className="flex gap-3 text-sm">
                  <Coins className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{product.supercoins.text}</span>
                </li>
              )}
            </ul>
          </Section>
        ) : null}

        {product.variants.length > 0 && (
          <Section title="Variants" count={product.variants.length}>
            <div className="flex flex-wrap gap-2">
              {product.variants.map((v, i) => (
                <Badge key={i} variant="outline" className="font-normal">
                  {v.name && <span className="mr-1 text-muted-foreground">{v.name}:</span>}
                  {v.value ?? v.options.join(" / ")}
                </Badge>
              ))}
            </div>
          </Section>
        )}

        {specs.length > 0 && (
          <Section title="Specifications" count={specs.length}>
            <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              {specs.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 border-b border-border/60 py-1.5">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="text-right">{v}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}

        {product.errors.length > 0 && (
          <Section title="Notes">
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {product.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </Section>
        )}

        <section className="rule-dashed pt-4">
          <button
            type="button"
            onClick={() => setShowJson((s) => !s)}
            className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className={cn("size-4 transition-transform", showJson && "rotate-180")} />
            {showJson ? "Hide" : "Show"} raw JSON
          </button>
          {showJson && (
            <pre className="tabular mt-3 max-h-[480px] overflow-auto rounded-md bg-primary p-4 text-xs text-primary-foreground">
              {JSON.stringify(product, null, 2)}
            </pre>
          )}
        </section>
      </div>
    </article>
  );
}
