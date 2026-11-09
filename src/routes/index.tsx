import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Loader2 } from "lucide-react";

import { ProductResult } from "@/components/product/ProductResult";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { lookupFromPage, unlockWebLookup } from "@/lib/flipkart/ui-session";
import type { ProductResponse } from "@/lib/flipkart/types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Flipkart Product Details — prices, offers & specs as JSON" },
      {
        name: "description",
        content:
          "Paste a Flipkart product link to see its price, MRP, discount, bank offers, rating, seller and specifications — or call the JSON API.",
      },
      { property: "og:title", content: "Flipkart Product Details — prices, offers & specs as JSON" },
      {
        property: "og:description",
        content: "Paste a Flipkart product link to see its price, offers, rating and specs, or call the JSON API.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const SAMPLE_URL =
  "https://www.flipkart.com/acer-aspire-3-intel-celeron-dual-core-8-gb-512-gb-ssd-windows-11-home-a311-45-thin-light-laptop/p/itmad38595c5a902?pid=COMH7NCZY2QDJ5Z4";

const FRIENDLY: Record<string, string> = {
  INVALID_URL: "That isn't a Flipkart product link. Product links contain “/p/” — open the product on Flipkart and copy the address.",
  PRODUCT_NOT_FOUND: "Flipkart says this product page doesn't exist anymore.",
  FLIPKART_BLOCKED:
    "Flipkart didn't let us read this page right now — it limits automated visits. Wait a little and try again.",
  INTERNAL_ERROR: "Something went wrong while reading the page. Try again.",
};

class LookupError extends Error {
  constructor(public code: string, public detail: string | null) {
    super(code);
  }
}

async function lookup(url: string): Promise<ProductResponse> {
  const result = await lookupFromPage({ data: { url } });
  if (!result.ok) throw new LookupError(result.error, result.detail);
  return result.product;
}

function Index() {
  const [url, setUrl] = useState("");
  const [origin, setOrigin] = useState("");
  const [password, setPassword] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: lookup });
  const unlock = useMutation({
    mutationFn: async (pw: string) => {
      const result = await unlockWebLookup({ data: { password: pw } });
      if (!result.ok) throw new LookupError(result.error, result.detail);
      return result;
    },
    onSuccess: () => {
      setPassword("");
      setUnlockError(null);
      mutation.reset();
      if (url.trim()) mutation.mutate(url.trim());
    },
    onError: (e) => setUnlockError((e as LookupError).detail ?? "Could not unlock the page."),
  });

  useEffect(() => setOrigin(window.location.origin), []);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) mutation.mutate(url.trim());
  };

  const err = mutation.error as LookupError | null;
  const needsPassword = err?.code === "UNAUTHORIZED";

  return (
    <div className="min-h-screen bg-ledger">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-sm bg-accent font-display text-lg text-accent-foreground">
            ₹
          </span>
          <span className="text-sm font-semibold tracking-tight">Flipkart Product Details</span>
        </div>
        <a href="#api" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
          API
        </a>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-24">
        <section className="pb-10 pt-10 sm:pt-16">
          <h1 className="max-w-3xl font-display text-5xl leading-[1.05] sm:text-6xl">
            Every detail behind a <em className="text-muted-foreground">Flipkart</em> price.
          </h1>
          <p className="mt-4 max-w-xl text-muted-foreground">
            Paste a product link. Get the price, MRP, discount, bank and exchange offers, rating, seller and
            specifications in one place.
          </p>

          <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.flipkart.com/…/p/…"
              aria-label="Flipkart product link"
              className="h-12 bg-card text-base"
            />
            <Button type="submit" size="lg" className="h-12 shrink-0" disabled={mutation.isPending}>
              {mutation.isPending ? <Loader2 className="animate-spin" /> : <ArrowRight />}
              {mutation.isPending ? "Reading page…" : "Get details"}
            </Button>
          </form>
          <button
            type="button"
            onClick={() => setUrl(SAMPLE_URL)}
            className="mt-3 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Try a sample link
          </button>
        </section>

        <div aria-live="polite">
          {needsPassword && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                unlock.mutate(password);
              }}
              className="animate-rise flex flex-col gap-3 rounded-lg border bg-card p-5 shadow-card sm:flex-row sm:items-center"
            >
              <p className="text-sm sm:flex-1">Enter the access password to look up products.</p>
              <Input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Access password"
                aria-label="Access password"
                autoComplete="current-password"
                className="bg-background sm:w-56"
              />
              <Button type="submit" disabled={unlock.isPending}>
                {unlock.isPending ? "Checking…" : "Unlock"}
              </Button>
              {unlockError && <p className="text-xs text-destructive sm:basis-full">{unlockError}</p>}
            </form>
          )}
          {err && !needsPassword && (
            <div className="animate-rise flex gap-3 rounded-lg border border-destructive/30 bg-card p-5 shadow-card">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
              <div>
                <p className="font-medium">{FRIENDLY[err.code] ?? FRIENDLY["INTERNAL_ERROR"]}</p>
                {err.detail && <p className="tabular mt-1 text-xs text-muted-foreground">{err.code} · {err.detail}</p>}
              </div>
            </div>
          )}
          {mutation.data && <ProductResult product={mutation.data} />}
        </div>

        <section id="api" className="mt-20 scroll-mt-8">
          <h2 className="font-display text-3xl">Use it as an API</h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Same JSON as before, now hosted. Keep request volume low and respect Flipkart's terms — CAPTCHAs and
            blocks are reported, never bypassed.
          </p>
          <div className="mt-6 overflow-hidden rounded-lg border bg-card shadow-card">
            {[
              ["GET", "/api/public/product?url=<flipkart_product_url>", "Product details (API key)"],
              ["GET", "/api/public/health", "Health check"],
              ["GET", "/api/public/ready", "Readiness (no Flipkart request)"],
              ["GET", "/api/public", "API info"],
            ].map(([m, p, d]) => (
              <div key={p} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-3 last:border-b-0">
                <span className="tabular rounded-sm bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-foreground">
                  {m}
                </span>
                <code className="tabular text-sm">{p}</code>
                <span className="ml-auto text-xs text-muted-foreground">{d}</span>
              </div>
            ))}
          </div>
          <pre className="tabular mt-4 overflow-x-auto rounded-lg bg-primary p-4 text-xs text-primary-foreground">
            {`curl -H "X-API-Key: YOUR_KEY" "${origin || "https://your-app"}/api/public/product?url=${SAMPLE_URL}"`}
          </pre>
          <p className="mt-4 text-xs text-muted-foreground">
            Errors: 400 INVALID_URL · 404 PRODUCT_NOT_FOUND · 503 FLIPKART_BLOCKED · 500 INTERNAL_ERROR
          </p>
        </section>
      </main>
    </div>
  );
}
