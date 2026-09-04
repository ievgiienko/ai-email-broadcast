import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/env.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // The integration tests share one database; running files in parallel would
    // let one file's TRUNCATE delete another file's fixtures mid-assertion.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
