import { createFileRoute } from "@tanstack/react-router";

import { healthResponse } from "@/lib/flipkart/api";

export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async () => healthResponse(),
    },
  },
});
