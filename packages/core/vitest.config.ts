import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts"],
    hookTimeout: 30000,
    testTimeout: 30000,
    // DB integration specs share one test database, so they must run truly
    // serially. fileParallelism:false alone still spawns multiple forks that
    // race on the shared DB (one file's TRUNCATE wipes another's rows mid-test);
    // singleFork forces one process end-to-end, which is the real guarantee.
    fileParallelism: false,
    poolOptions: { forks: { singleFork: true } },
  },
});
