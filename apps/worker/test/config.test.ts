import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { createLogger, loadWorkerConfig } from "../src/config";

// anvil public test key #0 — not a secret
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const base = {
  DATABASE_URL: "postgres://u:p@h/db",
  RPC_URL: "https://forno.celo.org",
  ROUTER_ADDRESS: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  ROUTER_DEPLOY_BLOCK: "81728773",
  PUBLIC_BASE_URL: "https://cobra.example",
  TELEGRAM_BOT_TOKEN: "t",
  RELAYER_PRIVATE_KEY: TEST_KEY,
  ATTRIBUTION_CODE: "celo_abcdef123456",
};

describe("worker config", () => {
  it("parses a valid env", () => {
    const c = loadWorkerConfig({ ...base, REF_RATES: '{"ARS":0.0006}', RELAYER_MIN_BALANCE_CELO: "1.5" });
    expect(c.router).toBe("0x5FbDB2315678afecb367f032d93F642f64180aa3");
    expect(c.routerDeployBlock).toBe(81728773n);
    expect(c.refRatesOverride).toEqual({ ARS: 0.0006 });
    expect(c.minBalanceWei).toBe(1_500_000_000_000_000_000n);
    expect(c.expectedChainId).toBe(42220);
  });

  it("lists every problem and never echoes the key", () => {
    const bad = "0xdeadbeefdeadbeef";
    let msg = "";
    try {
      loadWorkerConfig({ ...base, RELAYER_PRIVATE_KEY: bad, ATTRIBUTION_CODE: "Bad Code", DATABASE_URL: "" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/missing DATABASE_URL/);
    expect(msg).toMatch(/RELAYER_PRIVATE_KEY must be/);
    expect(msg).toMatch(/ATTRIBUTION_CODE/);
    expect(msg).not.toContain("deadbeef");
  });

  const V1 = "0x00000000000000000000000000000000c0b4a000";
  it("WS13: legacy router + Textile key parse; v1-only env keeps Textile off", () => {
    const c = loadWorkerConfig({ ...base, LEGACY_ROUTER_ADDRESS: V1, LEGACY_ROUTER_DEPLOY_BLOCK: "70000000", TEXTILE_API_KEY: "k" });
    expect(c.legacyRouter).toEqual({ address: getAddress(V1), deployBlock: 70000000n });
    expect(c.textileApiKey).toBe("k");
    const v1 = loadWorkerConfig(base);
    expect(v1.legacyRouter).toBeUndefined();
    expect(v1.textileApiKey).toBeUndefined();
    expect(loadWorkerConfig({ ...base, LEGACY_ROUTER_ADDRESS: V1, LEGACY_ROUTER_DEPLOY_BLOCK: "1", TEXTILE_API_KEY: "k", TEXTILE_ENABLED: "false" }).textileApiKey).toBeUndefined();
  });

  it("WS13: inconsistent router/Textile config is refused (worker exits 78) without echoing the key", () => {
    const fail = (env: Record<string, string>) => {
      try {
        loadWorkerConfig({ ...base, ...env });
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    expect(fail({ LEGACY_ROUTER_ADDRESS: V1 })).toMatch(/must be set together/);
    expect(fail({ LEGACY_ROUTER_DEPLOY_BLOCK: "5" })).toMatch(/must be set together/);
    expect(fail({ LEGACY_ROUTER_ADDRESS: base.ROUTER_ADDRESS, LEGACY_ROUTER_DEPLOY_BLOCK: "5" })).toMatch(/must differ/);
    const m = fail({ TEXTILE_API_KEY: "SECRET-TEXTILE" });
    expect(m).toMatch(/TEXTILE_API_KEY needs the v2 router/);
    expect(m).not.toContain("SECRET-TEXTILE");
    expect(fail({ TEXTILE_ENABLED: "maybe" })).toMatch(/TEXTILE_ENABLED/);
  });

  it("logs structured JSON with bigint support", () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l))("x", { level: "alert", n: 5n });
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "x", level: "alert", n: "5" });
  });
});
