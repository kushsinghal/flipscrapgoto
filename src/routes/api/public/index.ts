import { createFileRoute } from "@tanstack/react-router";

import { apiInfo } from "@/lib/flipkart/api";

export const Route = createFileRoute("/api/public/")({
  server: {
    handlers: {
      GET: async () => Response.json(apiInfo()),
    },
  },
});
