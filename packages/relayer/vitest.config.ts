import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // each test file spawns its own anvil instances; keep files sequential to stay light
    fileParallelism: false,
  },
});
