import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { eq } from "drizzle-orm";
import { fromDataSuffix, toDataSuffix } from "@celo/attribution-tags";
import { createWalletClient, http, type Address, type Hash } from "viem";
import { foundry } from "viem/chains";
import { cobraRouterAbi, hashInvoice } from "@cobra/shared";
import { flags, invoices, setFlag, submissions, type Db } from "@cobra/db";
import { createTestDb } from "@cobra/db/testing";
import { createRelayerSigner, startRelayer } from "../src/index";
import { claimNext, createRelayer, type RelayerConfig } from "../src/relayer";
import {
  ANVIL_KEYS,
  ATTRIBUTION_CODE,
  RATES,
  deployMocks,
  droppingTransport,
  hasAnvil,
  routerExtraAbi,
  seedSubmission,
  startAnvil,
  type Anvil,
} from "./helpers";

describe.skipIf(!hasAnvil)("relayer on anvil", () => {
  let a: Anvil;
  let db: Db;
  let router: Address;
  let token3009: Address;
  const logs: { msg: string; extra?: Record<string, unknown> }[] = [];

  beforeEach(async () => {
    a = await startAnvil();
    db = await createTestDb();
    ({ router, token3009 } = await deployMocks(a));
    logs.length = 0;
  });
  afterEach(async () => {
    await a.stop();
  });

  function signer(opts: { key?: `0x${string}`; drop?: boolean; walletCode?: string } = {}) {
    return createRelayerSigner({
      privateKey: opts.key ?? ANVIL_KEYS.relayer,
      rpcUrl: a.url,
      chain: foundry,
      ...(opts.drop && { transport: droppingTransport(a.url) }),
      attributionCode: ATTRIBUTION_CODE,
      ...(opts.walletCode && { walletAttributionCode: opts.walletCode }),
      router,
      db,
      rates: RATES,
      env: {},
    });
  }

  function relayer(s = signer(), extra: Partial<RelayerConfig> = {}) {
    return createRelayer({
      db,
      publicClient: a.publicClient,
      walletClient: s.walletClient,
      router,
      env: {},
      log: (msg, extra) => logs.push({ msg, ...(extra && { extra }) }),
      ...extra,
    });
  }

  /** anvil 1.x automines asynchronously: wait until the mempool is empty. */
  async function settle() {
    for (let i = 0; i < 200; i++) {
      const st = await a.test.getTxpoolStatus();
      if (st.pending === 0 && st.queued === 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("txpool did not drain");
  }
  const tick = async (r: { tick(): Promise<void> }) => {
    await r.tick();
    await settle();
  };

  const sub = async (id: string) => (await db.select().from(submissions).where(eq(submissions.id, id)))[0]!;
  const inv = async (id: string) => (await db.select().from(invoices).where(eq(invoices.id, id)))[0]!;
  const nonceOf = (addr: Address) => a.publicClient.getTransactionCount({ address: addr });
  const payCount = () => a.publicClient.readContract({ address: router, abi: routerExtraAbi, functionName: "payCount" });

  it("happy path: EIP-3009 + Permit2 legs → simulate, send with ERC-8021 tag, sent/submitted", async () => {
    const s = signer();
    const r = relayer(s);
    const seed = await seedSubmission(db, { router, token3009, kinds: ["eip3009", "permit2"] });
    await tick(r);

    const row = await sub(seed.submissionId);
    expect(row.error).toBeNull();
    expect(row.status).toBe("sent");
    expect(row.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(row.txNonce).toBe(0);
    expect((await inv(seed.invoiceId)).status).toBe("submitted");
    // WS7-6: the USD value used for the caps is frozen at signing time
    const [f] = await db.select().from(flags).where(eq(flags.key, `signed_usd:${seed.invoiceId.toLowerCase()}`));
    expect((f?.value as { usdScaled?: string } | undefined)?.usdScaled).toMatch(/^[1-9]\d*$/);

    const receipt = await a.publicClient.getTransactionReceipt({ hash: row.txHash as Hash });
    expect(receipt.status).toBe("success");
    expect(receipt.to?.toLowerCase()).toBe(router.toLowerCase());
    expect(await a.publicClient.readContract({ address: router, abi: cobraRouterAbi, functionName: "isPaid", args: [hashInvoice(seed.inv)] })).toBe(true);

    // ERC-8021: the sent calldata ends with the Schema 0 suffix for our code
    const tx = await a.publicClient.getTransaction({ hash: row.txHash as Hash });
    expect(tx.input.endsWith(toDataSuffix(ATTRIBUTION_CODE).slice(2))).toBe(true);
    const decoded = fromDataSuffix(tx.input);
    expect(decoded?.schemaId).toBe(0);
    expect(decoded?.codes).toEqual([ATTRIBUTION_CODE]);

    // later ticks never re-send (success is left to the indexer)
    await tick(r);
    await tick(r);
    expect(await nonceOf(s.address)).toBe(1);
    expect(await payCount()).toBe(1n);
    expect((await sub(seed.submissionId)).status).toBe("sent");
  });

  it("Schema 2 role suffix (app + wallet) when a wallet code is configured", async () => {
    const s = signer({ walletCode: "cobra_relayer" });
    const seed = await seedSubmission(db, { router, token3009 });
    await tick(relayer(s));
    const row = await sub(seed.submissionId);
    const tx = await a.publicClient.getTransaction({ hash: row.txHash as Hash });
    const d = fromDataSuffix(tx.input);
    expect(d?.schemaId).toBe(2);
    expect(d?.app).toBe(ATTRIBUTION_CODE);
    expect(d?.wallet).toBe("cobra_relayer");
  });

  it("kill switch (flag or env) blocks: nothing claimed, nothing sent", async () => {
    const s = signer();
    const seed = await seedSubmission(db, { router, token3009 });
    await setFlag(db, "kill_switch", { enabled: true });
    await tick(relayer(s));
    expect((await sub(seed.submissionId)).status).toBe("pending");
    expect(await nonceOf(s.address)).toBe(0);
    await setFlag(db, "kill_switch", { enabled: false });

    // env switch also enforced inside the signer itself
    const envSigner = createRelayerSigner({
      privateKey: ANVIL_KEYS.relayer, rpcUrl: a.url, chain: foundry, attributionCode: ATTRIBUTION_CODE,
      router, db, rates: RATES, env: { KILL_SWITCH: "true" },
    });
    await tick(relayer(envSigner));
    const row = await sub(seed.submissionId);
    // WS7-3: never broadcast -> not lost: back to pending (retry), attempt given back
    expect(row.status).toBe("pending");
    expect(row.txHash).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.error).toMatch(/kill_switch/);
    expect((await inv(seed.invoiceId)).status).toBe("open");
    expect(await nonceOf(s.address)).toBe(0);
  });

  it("per-payment cap exceeded → failed, invoice stays open, no tx", async () => {
    const s = signer();
    await setFlag(db, "caps", { perPaymentUsd: 1, perDayUsd: 2000 });
    const seed = await seedSubmission(db, { router, token3009 }); // ~2.7 USD
    await tick(relayer(s));
    const row = await sub(seed.submissionId);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/cap_per_payment/);
    expect((await inv(seed.invoiceId)).status).toBe("open");
    expect(await nonceOf(s.address)).toBe(0);
  });

  it("per-day cap counts invoices already relayed in the last 24h", async () => {
    const s = signer();
    await setFlag(db, "caps", { perPaymentUsd: 200, perDayUsd: 5 });
    const first = await seedSubmission(db, { router, token3009 }); // ~2.7 USD
    const r = relayer(s);
    await tick(r);
    expect((await sub(first.submissionId)).status).toBe("sent");
    const second = await seedSubmission(db, { router, token3009 }); // +2.7 > 5
    await tick(r);
    const row = await sub(second.submissionId);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/cap_per_day/);
    expect(await nonceOf(s.address)).toBe(1);
  });

  it("WS7-1: self-payment (payer == invoice merchant) → failed without any tx", async () => {
    const s = signer();
    const self = privateKeyToAccount(ANVIL_KEYS.payer).address;
    const seed = await seedSubmission(db, { router, token3009, merchant: self });
    await tick(relayer(s));
    const row = await sub(seed.submissionId);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("self_payment");
    expect((await inv(seed.invoiceId)).status).toBe("open");
    expect(await nonceOf(s.address)).toBe(0);
  });

  it("expired quote / expiring invoice / wrong signer / simulation revert → failed without any tx", async () => {
    const s = signer();
    const r = relayer(s);
    const q = await seedSubmission(db, { router, token3009, quoteExpiresInMs: -1000 });
    await tick(r);
    expect((await sub(q.submissionId)).error).toBe("quote_expired");

    const i = await seedSubmission(db, { router, token3009, expiresInSec: 10 }); // inside the 30 s margin
    await tick(r);
    expect((await sub(i.submissionId)).error).toBe("invoice_expired");

    const w = await seedSubmission(db, { router, token3009, kinds: ["permit2"], signerKey: ANVIL_KEYS.other });
    await tick(r);
    expect((await sub(w.submissionId)).error).toBe("leg0:signature_not_payer");

    const sim = await seedSubmission(db, { router, token3009, amountOut: 0xdeadn });
    await tick(r);
    expect((await sub(sim.submissionId)).error).toBe("simulation_reverted:InsufficientOutput(1,57005)");

    for (const x of [q, i, w, sim]) {
      expect((await sub(x.submissionId)).status).toBe("failed");
      expect((await inv(x.invoiceId)).status).toBe("open");
    }
    expect(await nonceOf(s.address)).toBe(0);
  });

  it("mined revert → submission failed with decoded error, invoice back to open", async () => {
    const s = signer();
    const r = relayer(s);
    const seed = await seedSubmission(db, { router, token3009 });
    await a.test.setAutomine(false);
    await r.tick();
    expect((await sub(seed.submissionId)).status).toBe("sent");
    expect((await inv(seed.invoiceId)).status).toBe("submitted");
    await a.test.setNextBlockTimestamp({ timestamp: seed.inv.deadline + 1n });
    await a.test.mine({ blocks: 1 });
    await r.tick();
    const row = await sub(seed.submissionId);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("tx_reverted:Expired");
    expect((await inv(seed.invoiceId)).status).toBe("open");
  });

  it("never overwrites a submission the indexer already confirmed / failed", async () => {
    const r = relayer(signer());
    const seed = await seedSubmission(db, { router, token3009 });
    await a.test.setAutomine(false);
    await r.tick();
    // indexer wins the race (e.g. superseded by another payer): submission failed, invoice paid
    await db.update(submissions).set({ status: "failed", error: "superseded" }).where(eq(submissions.id, seed.submissionId));
    await db.update(invoices).set({ status: "paid" }).where(eq(invoices.id, seed.invoiceId));
    await a.test.setNextBlockTimestamp({ timestamp: seed.inv.deadline + 1n });
    await a.test.mine({ blocks: 1 }); // our tx reverts
    await r.tick();
    const row = await sub(seed.submissionId);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("superseded");
    expect((await inv(seed.invoiceId)).status).toBe("paid");

    const seed2 = await seedSubmission(db, { router, token3009, expiresInSec: 3600 });
    await r.tick();
    await db.update(submissions).set({ status: "confirmed" }).where(eq(submissions.id, seed2.submissionId));
    await a.test.mine({ blocks: 1 });
    await r.tick();
    expect((await sub(seed2.submissionId)).status).toBe("confirmed");
  });

  it("stuck tx is replaced on the SAME nonce with bumped fees; only one gets mined", async () => {
    const s = signer();
    const r = relayer(s, { stuckAfterMs: 0 });
    const seed = await seedSubmission(db, { router, token3009 });
    await a.test.setAutomine(false);
    await r.tick();
    const first = await sub(seed.submissionId);
    const tx1 = await a.publicClient.getTransaction({ hash: first.txHash as Hash });
    await r.tick(); // pending longer than stuckAfterMs → replacement
    const second = await sub(seed.submissionId);
    expect(second.txHash).not.toBe(first.txHash);
    expect(second.txNonce).toBe(0);
    const tx2 = await a.publicClient.getTransaction({ hash: second.txHash as Hash });
    expect(tx2.nonce).toBe(0);
    expect(tx2.maxFeePerGas! > tx1.maxFeePerGas!).toBe(true);
    await a.test.mine({ blocks: 1 });
    await settle();
    expect((await a.publicClient.getTransactionReceipt({ hash: second.txHash as Hash })).status).toBe("success");
    await r.tick();
    expect(await nonceOf(s.address)).toBe(1);
    expect(await payCount()).toBe(1n);
    expect((await sub(seed.submissionId)).status).toBe("sent");
  });

  it("restart: signed-but-not-broadcast row is re-sent on its stored nonce, never a new one", async () => {
    const crashed = signer({ drop: true });
    const seed = await seedSubmission(db, { router, token3009 });
    await tick(relayer(crashed));
    const before = await sub(seed.submissionId);
    expect(before.status).toBe("sending");
    expect(before.txHash).toBeTruthy();
    expect(before.txNonce).toBe(0);
    expect(await nonceOf(crashed.address)).toBe(0); // nothing reached the chain

    const r2 = relayer(signer()); // fresh process
    await tick(r2);
    await tick(r2);
    const after = await sub(seed.submissionId);
    expect(after.status).toBe("sent");
    expect(after.txNonce).toBe(0);
    expect(await nonceOf(crashed.address)).toBe(1);
    expect(await payCount()).toBe(1n);
    expect(r2.nextNonce).toBe(1);
  });

  it("restart: sent row is only re-watched; sending row without hash is re-queued and sent once", async () => {
    const s = signer();
    const a1 = await seedSubmission(db, { router, token3009 });
    await tick(relayer(s));
    expect((await sub(a1.submissionId)).status).toBe("sent");

    // simulate a crash right after claim (never signed): row `sending` w/o hash, invoice already `submitted`
    const b = await seedSubmission(db, { router, token3009 });
    await db.update(submissions).set({ status: "sending" }).where(eq(submissions.id, b.submissionId));
    await db.update(invoices).set({ status: "submitted" }).where(eq(invoices.id, b.invoiceId));

    const r2 = relayer(signer());
    await tick(r2);
    await tick(r2);
    expect(await nonceOf(s.address)).toBe(2); // a1 once, b once
    expect(await payCount()).toBe(2n);
    expect((await sub(a1.submissionId)).txNonce).toBe(0);
    const rb = await sub(b.submissionId);
    expect(rb.status).toBe("sent");
    expect(rb.txNonce).toBe(1);
    expect(logs.some((l) => l.msg === "recover_requeued")).toBe(true);
  });

  it("concurrent claims of the same submission: exactly one winner, one tx", async () => {
    const seed = await seedSubmission(db, { router, token3009 });
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimNext(db)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)!.id).toBe(seed.submissionId);

    // (a claimed-but-unsigned row would be re-queued by recover(); retire it for the second half)
    await db.update(submissions).set({ status: "failed" }).where(eq(submissions.id, seed.submissionId));
    // two relayers (distinct keys) ticking at once on a fresh submission
    const seed2 = await seedSubmission(db, { router, token3009 });
    const s1 = signer();
    const s2 = signer({ key: ANVIL_KEYS.relayer2 });
    await Promise.all([relayer(s1).tick(), relayer(s2).tick()]);
    await settle();
    const n1 = await nonceOf(s1.address);
    const n2 = await nonceOf(s2.address);
    expect(n1 + n2).toBe(1);
    expect((await sub(seed2.submissionId)).status).toBe("sent");
  });

  it("low gas balance alerts the operator through the notifier (throttled)", async () => {
    const text = vi.fn(async (_to: string, _msg: string) => {});
    const notifier = { text, invoicePaid: vi.fn(async () => {}) };
    const r = relayer(signer(), { notifier, operatorChatId: "op-1", minBalanceWei: 10n ** 30n, balanceCheckEveryMs: 0 });
    await tick(r);
    await tick(r);
    expect(text).toHaveBeenCalledTimes(1);
    expect(text.mock.calls[0]![0]).toBe("op-1");
    expect(String(text.mock.calls[0]![1])).toMatch(/low gas balance/);
  });

  it("startRelayer runs the loop, stops gracefully, and rejects unguarded wallet clients", async () => {
    const raw = createWalletClient({ chain: foundry, transport: http(a.url) });
    expect(() => startRelayer({ db, publicClient: a.publicClient, walletClient: raw, router })).toThrow(/createRelayerSigner/);

    const s = signer();
    const seed = await seedSubmission(db, { router, token3009 });
    const h = startRelayer({ db, publicClient: a.publicClient, walletClient: s.walletClient, router, pollIntervalMs: 50 });
    for (let i = 0; i < 100 && (await sub(seed.submissionId)).status !== "sent"; i++) await new Promise((r) => setTimeout(r, 50));
    await h.stop();
    expect((await sub(seed.submissionId)).status).toBe("sent");
  });
});
