import { defineConfig } from "vitest/config";

// End-to-end suite on an anvil fork of Celo mainnet. NOT picked up by `pnpm test` (files are *.e2e.ts, outside
// vitest's default include). Run with `pnpm test:e2e`. See docs/testing-e2e.md.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
