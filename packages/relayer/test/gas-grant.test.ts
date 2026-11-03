import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { toDataSuffix } from "@celo/attribution-tags";
import { parseEther, type Address, type Hash, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { PullKind, randomInvoiceId, tokenBySymbol } from "@cobra/shared";
import { flags, invoices, quotes, setFlag, submissions, type Db } from "@cobra/db";
import { createTestDb } from "@cobra/db/testing";
import { createRelayerSigner, GAS_GRANT_MAX_WEI, SignerRefusedError } from "../src/signer";
import { GAS_GRANT_DEFAULTS, findGasGrantCandidates } from "../src/gas-grant";
import { createRelayer } from "../src/relayer";
import { ANVIL_KEYS, ATTRIBUTION_CODE, MERCHANT, RATES, deployMocks, hasAnvil, seedMerchant, seedSubmission, startAnvil, type Anvil } from "./helpers";

const WMXN = tokenBySymbol("wMXN")!.address;
const ROUTER: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const PAYER: Address = "0x00000000000000000000000000000000000b0b01";
const CFG = { ...GAS_GRANT_DEFAULTS };

async function seedQuote(db: Db, o: { payer?: Address; merchant?: Address; kind?: number; amountIn?: bigint; invoiceExpiresInSec?: number; status?: "open" | "paid" } = {}) {
  const m = await seedMerchant(db);
  const id = randomInvoiceId();
  await db.insert(invoices).values({
    id,
    merchantId: m.id,
    amountLocal: "200",
    currency: "MXN",
    tokenOut: WMXN,
    amountOut: (200n * 10n ** 18n).toString(),
    merchantAddress: o.merchant ?? MERCHANT,
    expiresAt: new Date(Date.now() + (o.invoiceExpiresInSec ?? 600) * 1000),
    ...(o.status && { status: o.status }),
  });
  const amountIn = o.amountIn ?? 200n * 10n ** 18n;
  await db.insert(quotes).values({
    invoiceId: id,
    payer: o.payer ?? PAYER,
    plan: {
      tokenOut: WMXN,
      minOut: (200n * 10n ** 18n).toString(),
      legs: [{ token: WMXN, amountIn: amountIn.toString(), kind: o.kind ?? PullKind.PERMIT2, path: "0x", quotedOut: amountIn.toString() }],
      costBps: 0,
      savingsBps: 0,
      expiresAt: Date.now() + 60_000,
      quotedAt: Date.now(),
    },
    expiresAt: new Date(Date.now() + 60_000),
  });
  return id;
}

/** Stub chain reads: native balance, ERC-20 balance and allowance per (token, owner). */
function stubClient(o: { native?: bigint; balance?: bigint; allowance?: bigint }) {
  return {
    getBalance: async () => o.native ?? 0n,
    readContract: async (args: { functionName: string }) => (args.functionName === "balanceOf" ? (o.balance ?? 300n * 10n ** 18n) : (o.allowance ?? 0n)),
  } as unknown as PublicClient;
}

describe("gas grant candidates (DB + stubbed chain)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });
  const find = (client: PublicClient, skip = new Map<string, number>()) =>
    findGasGrantCandidates({ db, publicClient: client, router: ROUTER, now: new Date(), cfg: CFG, skip });

  it("payer holds the wFIAT, no CELO, no approval yet → candidate", async () => {
    await seedQuote(db);
    const c = await find(stubClient({}));
    expect(c).toHaveLength(1);
    expect(c[0]!.payer.toLowerCase()).toBe(PAYER.toLowerCase());
    expect(c[0]!.token).toBe(WMXN);
  });

  it("no candidate when: payer has CELO, too few tokens, already approved, self-payment, EIP-3009 plan, closed or expired invoice", async () => {
    await seedQuote(db);
    expect(await find(stubClient({ native: parseEther("0.03") }))).toHaveLength(0);
    expect(await find(stubClient({ balance: 10n ** 18n }))).toHaveLength(0);
    expect(await find(stubClient({ allowance: 2n ** 255n }))).toHaveLength(0);

    const db2 = await createTestDb();
    const f2 = (client: PublicClient) => findGasGrantCandidates({ db: db2, publicClient: client, router: ROUTER, now: new Date(), cfg: CFG, skip: new Map() });
    await seedQuote(db2, { payer: MERCHANT, merchant: MERCHANT });
    await seedQuote(db2, { kind: PullKind.EIP3009 });
    await seedQuote(db2, { status: "paid" });
    await seedQuote(db2, { invoiceExpiresInSec: -10 });
    expect(await f2(stubClient({}))).toHaveLength(0);
  });

  it("one grant per address, ever: an existing gas_grant flag excludes the payer", async () => {
    await seedQuote(db);
    await setFlag(db, `gas_grant:${PAYER.toLowerCase()}`, { status: "sent" });
    expect(await find(stubClient({}))).toHaveLength(0);
  });

  it("ALLOWANCE legs need the router allowance, PERMIT2 legs the Permit2 one", async () => {
    await seedQuote(db, { kind: PullKind.ALLOWANCE });
    const spenders: string[] = [];
    const client = {
      getBalance: async () => 0n,
      readContract: async (args: { functionName: string; args: Address[] }) => {
        if (args.functionName === "allowance") spenders.push(args.args[1]!);
        return args.functionName === "balanceOf" ? 300n * 10n ** 18n : 0n;
      },
    } as unknown as PublicClient;
    expect(await find(client)).toHaveLength(1);
    expect(spenders).toEqual([ROUTER]);
  });
});

describe.skipIf(!hasAnvil)("gas grant on anvil (guarded signer + relayer nonces)", () => {
  let a: Anvil;
  let db: Db;
  let router: Address;
  let token3009: Address;
  beforeEach(async () => {
    a = await startAnvil();
    db = await createTestDb();
    ({ router, token3009 } = await deployMocks(a));
  });
  afterEach(async () => {
    await a.stop();
  });

  const signer = (env: Record<string, string> = {}) =>
    createRelayerSigner({ privateKey: ANVIL_KEYS.relayer, rpcUrl: a.url, chain: foundry, attributionCode: ATTRIBUTION_CODE, router, db, rates: RATES, env });
  const fresh = (n: number) => `0x00000000000000000000000000000000000a${n.toString(16).padStart(4, "0")}` as Address;
  const refused = async (p: Promise<unknown>, code: string) => {
    const e = await p.then(
      () => null,
      (x) => x,
    );
    expect(e).toBeInstanceOf(SignerRefusedError);
    expect((e as SignerRefusedError).code).toBe(code);
  };

  it("sends exactly the value to the payer, tagged ERC-8021, and records it; never twice", async () => {
    const s = signer();
    const to = fresh(1);
    const hash = await s.grantGas({ to, value: parseEther("0.05"), dailyMax: 20, reason: { invoiceId: "inv1" } });
    const r = await a.publicClient.waitForTransactionReceipt({ hash });
    expect(r.status).toBe("success");
    expect(await a.publicClient.getBalance({ address: to })).toBe(parseEther("0.05"));
    const tx = await a.publicClient.getTransaction({ hash: hash as Hash });
    expect(tx.input.toLowerCase()).toBe(toDataSuffix(ATTRIBUTION_CODE).toLowerCase());
    const [row] = await db.select().from(flags).where(eq(flags.key, `gas_grant:${to.toLowerCase()}`));
    expect(row?.value).toMatchObject({ status: "sent", txHash: hash, invoiceId: "inv1" });

    await refused(s.grantGas({ to, value: parseEther("0.05"), dailyMax: 20 }), "grant_already_given");
  });

  it("refuses: above the hard max, zero, the router, self, a contract, the daily cap, the kill switch", async () => {
    const s = signer();
    await refused(s.grantGas({ to: fresh(2), value: GAS_GRANT_MAX_WEI + 1n, dailyMax: 20 }), "grant_value");
    await refused(s.grantGas({ to: fresh(3), value: 0n, dailyMax: 20 }), "grant_value");
    await refused(s.grantGas({ to: router, value: parseEther("0.01"), dailyMax: 20 }), "grant_target");
    await refused(s.grantGas({ to: s.address, value: parseEther("0.01"), dailyMax: 20 }), "grant_target");
    await refused(s.grantGas({ to: token3009, value: parseEther("0.01"), dailyMax: 20 }), "grant_target");
    await s.grantGas({ to: fresh(4), value: parseEther("0.01"), dailyMax: 1 });
    await refused(s.grantGas({ to: fresh(5), value: parseEther("0.01"), dailyMax: 1 }), "grant_daily_cap");
    await refused(signer({ KILL_SWITCH: "true" }).grantGas({ to: fresh(6), value: parseEther("0.01"), dailyMax: 20 }), "kill_switch");
    // refusals never consumed a slot: only fresh(4) got a grant
    const keys = (await db.select({ k: flags.key }).from(flags)).map((r) => r.k).filter((k) => k.startsWith("gas_grant:"));
    expect(keys).toEqual([`gas_grant:${fresh(4).toLowerCase()}`]);
  });

  it("the pay path still refuses value and non-router targets (grant mode is never left open)", async () => {
    const s = signer();
    await s.grantGas({ to: fresh(7), value: parseEther("0.01"), dailyMax: 20 });
    await refused(s.walletClient.sendTransaction({ to: fresh(8), data: "0x", value: 1n } as never), "wrong_target");
  });

  it("a grant and a relayed payment share the wallet without nonce conflicts", async () => {
    const s = signer();
    const r = createRelayer({ db, publicClient: a.publicClient, walletClient: s.walletClient, router, env: {}, gasGrant: false });
    await s.grantGas({ to: fresh(9), value: parseEther("0.01"), dailyMax: 20 }); // nonce 0, outside the relayer
    const seed = await seedSubmission(db, { router, token3009, kinds: ["eip3009"] });
    await r.tick();
    const [row] = await db.select().from(submissions).where(eq(submissions.id, seed.submissionId));
    expect(row?.error).toBeNull();
    expect(row?.status).toBe("sent");
    expect(row?.txNonce).toBe(1);
    const rc = await a.publicClient.waitForTransactionReceipt({ hash: row!.txHash as Hash });
    expect(rc.status).toBe("success");
  });
});

