import { defineConfig } from "@scalar/cli-config";

export default defineConfig({
  servers: [
    {
      url: "http://localhost:8000",
      description: "Local Development",
    },
  ],
  pages: [
    {
      sidebar: [
        {
          group: "API Reference",
          pages: [{ content: "./scalar/openapi.json", title: "Document Intelligence API" }],
        },
      ],
    },
  ],
});
