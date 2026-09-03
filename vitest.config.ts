import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "tests/", "**/*.spec.ts", "**/*.test.ts", "**/*.schema.ts"],
    },
  },
  resolve: {
    alias: [
      // Redirect @/db exactly to the in-memory PGlite test database.
      // The regex ensures @/db/schema and other sub-paths are NOT affected
      // and continue to resolve through the general "@" alias below.
      { find: /^@\/db$/, replacement: path.resolve(__dirname, "./tests/test.db.ts") },
      { find: "@middleware", replacement: path.resolve(__dirname, "./src/middleware") },
      { find: "@db", replacement: path.resolve(__dirname, "./src/db") },
      { find: "@utils", replacement: path.resolve(__dirname, "./src/utils") },
      { find: "@modules", replacement: path.resolve(__dirname, "./src/modules") },
      { find: "@tests", replacement: path.resolve(__dirname, "./tests") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
});
