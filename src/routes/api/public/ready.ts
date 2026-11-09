import { createFileRoute } from "@tanstack/react-router";

import { readyResponse } from "@/lib/flipkart/api";

// GET /api/public/ready: configuration and (browser mode) local Chromium check. Never contacts Flipkart.
export const Route = createFileRoute("/api/public/ready")({
  server: {
    handlers: {
      GET: async () => readyResponse(),
    },
  },
});
