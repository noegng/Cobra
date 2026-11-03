import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import { cobraRouterAbi, PullKind } from "@cobra/shared";
import { flags, invoices, setFlag, submissions, type Db } from "@cobra/db";
import { createTestDb } from "@cobra/db/testing";
import { createRelayerSigner, PAY_SELECTOR, SIGNED_USD_PREFIX, SignerRefusedError, type RelayerSigner } from "../src/signer";
import { buildRegistrationFile, registerCalldata, REGISTRATION_TYPE } from "../src/agent";
import { usdValueScaled, USD_SCALE } from "../src/rates";
import { ANVIL_KEYS, ATTRIBUTION_CODE, MERCHANT, RATES, seedMerchant, WARS } from "./helpers";

const ROUTER: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const OTHER: Address = "0x00000000000000000000000000000000DeaDBeef";
const PAYER: Address = "0x000000000000000000000000000000000000bEEF";

function payData(
  amountOut = 4500n * 10n ** 18n,
  tokenOut: Address = WARS,
  merchant: Address = OTHER,
  payer: Address = PAYER,
  id: Hex = `0x${"11".repeat(32)}`,
): Hex {
  return encodeFunctionData({
    abi: cobraRouterAbi,
    functionName: "pay",
    args: [
      { id, merchant, tokenOut, amountOut, deadline: 2_000_000_000n },
      payer,
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

  it("WS7-7: zero amountOut or any zero amountIn leg is refused", async () => {
    expect(await code(s.check({ to: ROUTER, data: payData(0n) }))).toBe("zero_amount");
    const zeroLeg = (amountIn: bigint) =>
      encodeFunctionData({
        abi: cobraRouterAbi,
        functionName: "pay",
        args: [
          { id: `0x${"11".repeat(32)}`, merchant: OTHER, tokenOut: WARS, amountOut: 1000n, deadline: 2_000_000_000n },
          PAYER,
          [
            { token: WARS, amountIn: 5n, kind: PullKind.PERMIT2, pullData: "0x", path: "0x" },
            { token: WARS, amountIn, kind: PullKind.PERMIT2, pullData: "0x", path: "0x" },
          ],
        ],
      });
    expect(await code(s.check({ to: ROUTER, data: zeroLeg(0n) }))).toBe("zero_amount");
    expect(await code(s.send({ to: ROUTER, data: zeroLeg(0n) }))).toBe("zero_amount");
    expect(await code(s.check({ to: ROUTER, data: zeroLeg(1n) }))).toBe("ok");
  });

  it("WS7-1: self-payment (payer == invoice.merchant) is refused", async () => {
    expect(await code(s.check({ to: ROUTER, data: payData(undefined, undefined, OTHER, OTHER) }))).toBe("self_payment");
    expect(await code(s.check({ to: ROUTER, data: payData(undefined, undefined, PAYER, PAYER) }))).toBe("self_payment");
  });

  it("WS7-1: one merchant / one payer cannot exhaust the global daily budget", async () => {
    // A relayed (sent) ~2.7 USD invoice: merchant MERCHANT, payer PAYER, 1 minute ago.
    const m = await seedMerchant(db);
    const id = `0x${"22".repeat(32)}` as Hex;
    await db.insert(invoices).values({
      id, merchantId: m.id, amountLocal: "4500", currency: "ARS", tokenOut: WARS,
      amountOut: (4500n * 10n ** 18n).toString(), merchantAddress: MERCHANT, expiresAt: new Date(Date.now() + 600_000),
    });
    await db.insert(submissions).values({ invoiceId: id, payer: PAYER, legs: [], status: "sent", txHash: `0x${"ab".repeat(32)}` });
    const fresh: Address = "0x000000000000000000000000000000000000f00d";
    const nextId = `0x${"33".repeat(32)}` as Hex;
    try {
      // Global budget is ample; the per-merchant budget is not.
      await setFlag(db, "caps", { perPaymentUsd: 200, perDayUsd: 2000, perMerchantDayUsd: 5, perPayerDayUsd: 2000 });
      expect(await code(s.check({ to: ROUTER, data: payData(undefined, undefined, MERCHANT, fresh, nextId) }))).toBe("cap_per_merchant_day");
      expect(await code(s.check({ to: ROUTER, data: payData(undefined, undefined, OTHER, fresh, nextId) }))).toBe("ok");
      // Same for the payer.
      await setFlag(db, "caps", { perPaymentUsd: 200, perDayUsd: 2000, perMerchantDayUsd: 2000, perPayerDayUsd: 5 });
      expect(await code(s.check({ to: ROUTER, data: payData(undefined, undefined, OTHER, PAYER, nextId) }))).toBe("cap_per_payer_day");
      expect(await code(s.check({ to: ROUTER, data: payData(undefined, undefined, OTHER, fresh, nextId) }))).toBe("ok");
      // Stored flags without the new fields fall back to DEFAULT_CAPS (500 USD each), not "unlimited".
      await setFlag(db, "caps", { perPaymentUsd: 200, perDayUsd: 2000 });
      expect(await code(s.check({ to: ROUTER, data: payData(200n * 1650n * 10n ** 18n - 10n ** 18n, undefined, MERCHANT, fresh, nextId) }))).toBe("ok");
    } finally {
      await db.delete(submissions);
      await setFlag(db, "caps", { perPaymentUsd: 200, perDayUsd: 2000 });
    }
  });

  it("WS7-6: rolling caps sum the USD value frozen at signing time, not today's rate", async () => {
    const m = await seedMerchant(db);
    const id = `0x${"44".repeat(32)}` as Hex;
    await db.insert(invoices).values({
      id, merchantId: m.id, amountLocal: "4500", currency: "ARS", tokenOut: WARS,
      amountOut: (4500n * 10n ** 18n).toString(), merchantAddress: MERCHANT, expiresAt: new Date(Date.now() + 600_000),
    });
    await db.insert(submissions).values({ invoiceId: id, payer: PAYER, legs: [], status: "sent", txHash: `0x${"cd".repeat(32)}` });
    const fresh: Address = "0x000000000000000000000000000000000000f00d";
    const nextId = `0x${"55".repeat(32)}` as Hex;
    try {
      await setFlag(db, "caps", { perPaymentUsd: 200, perDayUsd: 2000, perMerchantDayUsd: 50, perPayerDayUsd: 2000 });
      // no stored value: recomputed at the current rate (~2.7 USD) -> fits
      expect(await code(s.check({ to: ROUTER, data: payData(undefined, undefined, MERCHANT, fresh, nextId) }))).toBe("ok");
      // stored at signing time as 100 USD (rate was very different) -> the stored value wins
      await setFlag(db, `${SIGNED_USD_PREFIX}${id}`, { usdScaled: (100n * USD_SCALE).toString(), currency: "ARS" });
      expect(await code(s.check({ to: ROUTER, data: payData(undefined, undefined, MERCHANT, fresh, nextId) }))).toBe("cap_per_merchant_day");
    } finally {
      await db.delete(submissions);
      await db.delete(flags).where(eq(flags.key, `${SIGNED_USD_PREFIX}${id}`));
      await setFlag(db, "caps", { perPaymentUsd: 200, perDayUsd: 2000 });
    }
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
