import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts"],
    hookTimeout: 30000,
    testTimeout: 30000,
    // DB integration specs share one test database; run files serially.
    fileParallelism: false,
  },
});
