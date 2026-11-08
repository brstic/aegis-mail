import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/worker/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // DB-backed suites each create their own database; serialized file execution
    // keeps connection counts sane on a laptop Postgres.
    fileParallelism: false,
    env: { NODE_ENV: "test" },
  },
});
