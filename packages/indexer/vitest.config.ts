import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite (Postgres in WASM) boots and applies every migration per test DB: ~2 s locally, ~5 s on
    // GitHub runners, which hit vitest's 5 s default. Same budget as apps/web and packages/relayer.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
