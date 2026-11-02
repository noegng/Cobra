import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import { cobraRouterAbi, PullKind } from "@cobra/shared";
import { setFlag, type Db } from "@cobra/db";
import { createTestDb } from "@cobra/db/testing";
import { createRelayerSigner, PAY_SELECTOR, SignerRefusedError, type RelayerSigner } from "../src/signer";
import { buildRegistrationFile, registerCalldata, REGISTRATION_TYPE } from "../src/agent";
import { createHttpRates, usdValueScaled, USD_SCALE } from "../src/rates";
import { ANVIL_KEYS, ATTRIBUTION_CODE, RATES, WARS } from "./helpers";

const ROUTER: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const OTHER: Address = "0x00000000000000000000000000000000DeaDBeef";

function payData(amountOut = 4500n * 10n ** 18n, tokenOut: Address = WARS): Hex {
  return encodeFunctionData({
    abi: cobraRouterAbi,
    functionName: "pay",
    args: [
      { id: `0x${"11".repeat(32)}`, merchant: OTHER, tokenOut, amountOut, deadline: 2_000_000_000n },
      OTHER,
      [{ token: tokenOut, amountIn: 1n, kind: PullKind.PERMIT2, pullData: "0x", path: "0x" }],
    ],
  });
}

// Pure guard tests: refusals happen before any RPC, so the RPC URL is never contacted.
describe("signer guards", () => {
  let db: Db;
  let s: RelayerSigner;
  beforeAll(async () => {
    db = await createTestDb();
    s = createRelayerSigner({
      privateKey: ANVIL_KEYS.relayer, rpcUrl: "http://127.0.0.1:1", chain: foundry,
      attributionCode: ATTRIBUTION_CODE, router: ROUTER, db, rates: RATES, env: {},
    });
  });
  afterAll(() => undefined);

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      return e instanceof SignerRefusedError ? e.code : `other:${(e as Error).message}`;
    }
  };

  it("pay selector matches the frozen ABI", () => {
    expect(payData().slice(0, 10)).toBe(PAY_SELECTOR);
  });

  it("refuses any target other than the router, contract creation and value", async () => {
    expect(await code(s.walletClient.sendTransaction({ to: OTHER, data: payData() } as never))).toBe("wrong_target");
    expect(await code(s.walletClient.sendTransaction({ data: payData() } as never))).toBe("wrong_target");
    expect(await code(s.send({ to: ROUTER, data: payData(), value: 1n }))).toBe("value_not_zero");
  });

  it("refuses calldata that is not pay()", async () => {
    const approve = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [OTHER, 1n] });
    expect(await code(s.send({ to: ROUTER, data: approve }))).toBe("wrong_selector");
    expect(await code(s.send({ to: ROUTER, data: "0x" }))).toBe("wrong_selector");
    expect(await code(s.send({ to: ROUTER, data: `${PAY_SELECTOR}deadbeef` }))).toBe("wrong_selector");
    expect(
      await code(
        s.walletClient.writeContract({ address: ROUTER, abi: parseAbi(["function sweep(address)"]), functionName: "sweep", args: [OTHER] } as never),
      ),
    ).toBe("wrong_selector");
  });

  it("blocks every other signing path on the exposed client", async () => {
    expect(s.walletClient.account?.type).toBe("json-rpc"); // the key is not reachable from the client
    expect(await code(s.walletClient.signMessage({ message: "x" } as never))).toBe("blocked_method");
    expect(await code(s.walletClient.signTransaction({} as never))).toBe("blocked_method");
    expect(await code(s.walletClient.signTypedData({} as never))).toBe("blocked_method");
    expect(await code(s.walletClient.deployContract({} as never))).toBe("blocked_method");
    expect(await code(s.walletClient.sendRawTransaction({} as never))).toBe("blocked_method");
  });

  it("unknown token or missing rate fails closed", async () => {
    expect(await code(s.check({ to: ROUTER, data: payData(1n, OTHER) }))).toBe("unknown_token");
    const noRate = createRelayerSigner({
      privateKey: ANVIL_KEYS.relayer, rpcUrl: "http://127.0.0.1:1", chain: foundry,
      attributionCode: ATTRIBUTION_CODE, router: ROUTER, db, rates: { USD: 1 }, env: {},
    });
    expect(await code(noRate.check({ to: ROUTER, data: payData() }))).toBe("missing_rate");
  });

  it("caps: per-payment and per-day from flags", async () => {
    expect(await s.check({ to: ROUTER, data: payData() })).toEqual({ usd: expect.closeTo(2.727, 2) });
    await setFlag(db, "caps", { perPaymentUsd: 2, perDayUsd: 100 });
    expect(await code(s.check({ to: ROUTER, data: payData() }))).toBe("cap_per_payment");
    await setFlag(db, "caps", { perPaymentUsd: 200, perDayUsd: 2 });
    expect(await code(s.check({ to: ROUTER, data: payData() }))).toBe("cap_per_day");
    await setFlag(db, "caps", { perPaymentUsd: 200, perDayUsd: 2000 });
  });

  it("kill switch from env or flag", async () => {
    const envOn = createRelayerSigner({
      privateKey: ANVIL_KEYS.relayer, rpcUrl: "http://127.0.0.1:1", chain: foundry,
      attributionCode: ATTRIBUTION_CODE, router: ROUTER, db, rates: RATES, env: { KILL_SWITCH: "true" },
    });
    expect(await code(envOn.check({ to: ROUTER, data: payData() }))).toBe("kill_switch");
    await setFlag(db, "kill_switch", { enabled: true });
    expect(await code(s.send({ to: ROUTER, data: payData() }))).toBe("kill_switch");
    await setFlag(db, "kill_switch", { enabled: false });
  });

  it("rejects malformed keys without echoing them and never exposes the key", () => {
    const bad = "0x1234";
    expect(() =>
      createRelayerSigner({ privateKey: bad as Hex, rpcUrl: "", attributionCode: "x", router: ROUTER, db, rates: RATES }),
    ).toThrow(/^RELAYER_PRIVATE_KEY must be/);
    expect(JSON.stringify(s)).not.toContain(ANVIL_KEYS.relayer.slice(2));
    expect(Object.values(s).join(" ")).not.toContain(ANVIL_KEYS.relayer.slice(2));
  });
});

describe("rates", () => {
  it("scaled USD values are exact integers", () => {
    expect(usdValueScaled(10n ** 6n, 6, "USD", {})).toBe(USD_SCALE);
    expect(() => usdValueScaled(1n, 18, "BRL", {})).toThrow(/missing_rate/);
  });
  it("http rates invert per-USD quotes, cache, and apply overrides", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(JSON.stringify({ rates: { ARS: 1600, BRL: 5 } }));
    }) as typeof fetch;
    const get = createHttpRates({ fetchFn, overrides: { BRL: 0.19 } });
    const r = await get();
    expect(r.ARS).toBeCloseTo(1 / 1600);
    expect(r.BRL).toBe(0.19);
    await get();
    expect(calls).toBe(1);
  });
});

describe("ERC-8004 agent card", () => {
  it("builds a registration-v1 file with the fields 8004scan requires", () => {
    const f = buildRegistrationFile({ publicBaseUrl: "https://cobra.example/", wallet: OTHER, agentId: 7 });
    expect(f.type).toBe(REGISTRATION_TYPE);
    expect(f.name && f.description && f.image.startsWith("https://")).toBeTruthy();
    expect(f.services.length).toBeGreaterThan(0);
    expect("endpoints" in f).toBe(false);
    expect(f.services).toContainEqual({ name: "agentWallet", endpoint: `eip155:42220:${OTHER}` });
    expect(f.registrations).toEqual([{ agentId: 7, agentRegistry: "eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }]);
  });
  it("register(string) calldata", () => {
    expect(registerCalldata("https://cobra.example/.well-known/agent-registration.json").slice(0, 10)).toBe("0xf2c298be");
  });
});
