import { createFileRoute } from "@tanstack/react-router";

import { debugRoute } from "@/lib/flipkart/api";

// GET /api/public/debug?url=<flipkart_product_url>
// Off unless ENABLE_DEBUG_ENDPOINT=true; requires an API key. Page HTML only when DEBUG_SAVE_HTML=true outside production.
export const Route = createFileRoute("/api/public/debug")({
  server: {
    handlers: {
      GET: async ({ request }) => debugRoute(request),
      OPTIONS: async ({ request }) => debugRoute(request),
    },
  },
});
