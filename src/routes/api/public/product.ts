import { createFileRoute } from "@tanstack/react-router";

import { productRoute } from "@/lib/flipkart/api";

// GET /api/public/product?url=<flipkart_product_url>
// Requires an API key (X-API-Key or Authorization: Bearer). Fetches one Flipkart product page.
export const Route = createFileRoute("/api/public/product")({
  server: {
    handlers: {
      GET: async ({ request }) => productRoute(request),
      OPTIONS: async ({ request }) => productRoute(request),
    },
  },
});
