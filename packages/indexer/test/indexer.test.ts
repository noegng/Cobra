import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { chainCursor, invoices, payments, quotes, submissions, unmatchedEvents, type Db } from "@cobra/db";
import { serializeLeg, type SerializedPlan } from "@cobra/shared";
import { CURSOR_ID, applyBatch, drainOutbox, expireInvoices, listOutbox, startIndexer, type Stoppable } from "../src/index";
import { CursorMovedError } from "../src/reconcile";
import {
  MERCHANT,
  OTHER,
  PAYER,
  RecordingNotifier,
  WARS,
  WBRL,
  chainClients,
  freshDb,
  makeClients,
  randomInvoiceId,
  seedInvoice,
  seedMerchant,
  sleep,
  startAnvil,
  waitFor,
  type Anvil,
  type RpcCall,
} from "./helpers";

const AMOUNT = 4500n * 10n ** 18n;

let anvil: Anvil;
let chain: ReturnType<typeof chainClients>;
const running: Stoppable[] = [];

beforeAll(async () => {
  anvil = await startAnvil();
  chain = chainClients(anvil.url);
}, 20_000);
afterAll(async () => {
  await anvil?.stop();
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop()));
});

interface Setup {
  db: Db;
  router: Address;
  fromBlock: bigint;
  notifier: RecordingNotifier;
  logs: { msg: string; extra?: Record<string, unknown> }[];
  calls: RpcCall[];
  start(over?: { confirmations?: number; maxBlockRange?: number; maxLogsRange?: number; faults?: { method: string; remaining: number }; reorgCheckIntervalMs?: number; reorgMinSuspectGapMs?: number }): Stoppable;
}

async function setup(): Promise<Setup> {
  const db = await freshDb();
  const { address: router, block } = await chain.deployEmitter();
  const notifier = new RecordingNotifier();
  const logs: Setup["logs"] = [];
  const calls: RpcCall[] = [];
  return {
    db,
    router,
    fromBlock: block,
    notifier,
    logs,
    calls,
    start(over = {}) {
      const { publicClient } = makeClients(anvil.url, { calls, maxLogsRange: over.maxLogsRange, faults: over.faults });
      const ix = startIndexer({
        db,
        publicClient,
        router,
        fromBlock: block,
        confirmations: over.confirmations ?? 0,
        maxBlockRange: over.maxBlockRange,
        pollIntervalMs: 20,
        ...(over.reorgCheckIntervalMs !== undefined && { reorgCheckIntervalMs: over.reorgCheckIntervalMs }),
        ...(over.reorgMinSuspectGapMs !== undefined && { reorgMinSuspectGapMs: over.reorgMinSuspectGapMs }),
        notifier,
        log: (msg, extra) => logs.push({ msg, extra }),
      });
      running.push(ix);
      return ix;
    },
  };
}

const rpc = async (method: string, params: unknown[] = []) => {
  const r = await fetch(anvil.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await r.json()) as { result: unknown }).result;
};
const cursorOf = async (db: Db) => (await db.select().from(chainCursor).where(eq(chainCursor.id, CURSOR_ID)))[0]?.blockNumber;
const invoiceOf = async (db: Db, id: string) => (await db.select().from(invoices).where(eq(invoices.id, id)))[0]!;
const waitCursorPast = (db: Db, block: bigint) => waitFor(async () => ((await cursorOf(db)) ?? 0n) > block, 20_000, `cursor > ${block}`);

describe("startIndexer — reconciliation against anvil", () => {
  it("open -> paid: payment row, invoice paid at block time, notifier once, cursor advanced", async () => {
    const s = await setup();
    const m = await seedMerchant(s.db);
    const inv = await seedInvoice(s.db, m.id);
    const ev = await chain.emitPaid(s.router, { invoiceId: inv.id as Hex, amountOut: AMOUNT });
    s.start();
    await waitCursorPast(s.db, ev.block);
    await waitFor(async () => s.notifier.paid.length > 0, 15_000, "notify");

    const [p] = await s.db.select().from(payments).where(eq(payments.invoiceId, inv.id));
    expect(p).toMatchObject({ txHash: ev.txHash, logIndex: ev.logIndex, payer: PAYER, tokenOut: WARS, amountOut: AMOUNT.toString(), blockNumber: ev.block, legs: null, costBps: null });
    expect(p!.paidAt.getTime()).toBe(Number(ev.timestamp) * 1000);
    const row = await invoiceOf(s.db, inv.id);
    expect(row.status).toBe("paid");
    expect(row.paidAt?.getTime()).toBe(Number(ev.timestamp) * 1000);
    expect(s.notifier.paid).toEqual([
      { merchantId: m.id, invoiceId: inv.id, amountLocal: "4500", currency: "ARS", reference: "A-0042", txHash: ev.txHash },
    ]);
    expect(await listOutbox(s.db)).toEqual([]);
    expect(await s.db.select().from(unmatchedEvents)).toEqual([]);
  });

  it("submitted -> paid: copies legs + cost/savings from submission & quote, submission confirmed", async () => {
    const s = await setup();
    const m = await seedMerchant(s.db);
    const inv = await seedInvoice(s.db, m.id, { status: "submitted" });
    const plan: SerializedPlan = {
      legs: [{ token: WBRL, amountIn: "100", kind: 1, path: "0x", quotedOut: "100" }],
      tokenOut: WARS, minOut: AMOUNT.toString(), costBps: 42.4, naiveCostBps: 120.2, savingsBps: 77.8, quotedAt: 1, expiresAt: 2, // real plans are fractional
    };
    const [q] = await s.db.insert(quotes).values({ invoiceId: inv.id, payer: PAYER, plan, expiresAt: new Date(Date.now() + 60_000) }).returning();
    const legs = [serializeLeg({ token: WBRL, amountIn: 100n, kind: 1, pullData: "0x1234", path: "0x" })];
    const [sub] = await s.db.insert(submissions).values({ invoiceId: inv.id, quoteId: q!.id, payer: PAYER.toLowerCase(), legs, status: "sent", txHash: "0xdead" }).returning();

    const ev = await chain.emitPaid(s.router, { invoiceId: inv.id as Hex, amountOut: AMOUNT });
    s.start();
    await waitCursorPast(s.db, ev.block);

    const [p] = await s.db.select().from(payments).where(eq(payments.invoiceId, inv.id));
    expect(p).toMatchObject({ legs, costBps: 42, savingsBps: 78, txHash: ev.txHash }); // rounded into the integer columns
    expect((await invoiceOf(s.db, inv.id)).status).toBe("paid");
    const [sub2] = await s.db.select().from(submissions).where(eq(submissions.id, sub!.id));
    expect(sub2).toMatchObject({ status: "confirmed", txHash: ev.txHash });
    await waitFor(async () => s.notifier.paid.length === 1, 15_000, "notify");
  });

  it("WS7-4 reorg: a Paid log that vanishes un-pays the invoice, rewinds the cursor, and a re-included tx pays again", async () => {
    const s = await setup();
    const m = await seedMerchant(s.db);
    const inv = await seedInvoice(s.db, m.id, { status: "submitted" });
    const [sub] = await s.db.insert(submissions).values({ invoiceId: inv.id, payer: PAYER.toLowerCase(), legs: [], status: "sent", txHash: "0xdead" }).returning();
    const snap = await rpc("evm_snapshot");
    const ev = await chain.emitPaid(s.router, { invoiceId: inv.id as Hex, amountOut: AMOUNT });
    const first = s.start({ reorgCheckIntervalMs: 0 });
    await waitCursorPast(s.db, ev.block);
    await waitFor(async () => (await invoiceOf(s.db, inv.id)).status === "paid", 15_000, "paid");
    await first.stop();

    // the block is reorged away
    await rpc("evm_revert", [snap]);
    await rpc("anvil_mine", ["0x3"]);
    s.start({ reorgCheckIntervalMs: 0, reorgMinSuspectGapMs: 0 });
    await waitFor(async () => (await invoiceOf(s.db, inv.id)).status === "submitted", 15_000, "invoice un-paid");
    expect(await s.db.select().from(payments).where(eq(payments.invoiceId, inv.id))).toEqual([]);
    expect((await invoiceOf(s.db, inv.id)).paidAt).toBeNull();
    const [sub2] = await s.db.select().from(submissions).where(eq(submissions.id, sub!.id));
    expect(sub2).toMatchObject({ status: "sent" });
    expect(s.logs.some((l) => l.msg === "indexer_alert_reorg_payment_reverted")).toBe(true);
    await waitFor(async () => s.notifier.texts.some((t) => /reorg/i.test(t.message)), 15_000, "reorg notice");

    // the same payment lands again later: applied normally
    const ev2 = await chain.emitPaid(s.router, { invoiceId: inv.id as Hex, amountOut: AMOUNT });
    await waitFor(async () => (await invoiceOf(s.db, inv.id)).status === "paid", 15_000, "paid again");
    expect(ev2.block).toBeGreaterThan(0n);
  });

  it("WS7-4 reorg guard leaves a still-valid payment untouched", async () => {
    const s = await setup();
    const m = await seedMerchant(s.db);
    const inv = await seedInvoice(s.db, m.id);
    const ev = await chain.emitPaid(s.router, { invoiceId: inv.id as Hex, amountOut: AMOUNT });
    s.start({ reorgCheckIntervalMs: 0 });
    await waitCursorPast(s.db, ev.block);
    await sleep(300);
    expect((await invoiceOf(s.db, inv.id)).status).toBe("paid");
    expect(s.logs.some((l) => l.msg.includes("reorg"))).toBe(false);
  });

  it("a live submission from another payer is failed (superseded) and its legs are not copied", async () => {
    const s = await setup();
    const m = await seedMerchant(s.db);
    const inv = await seedInvoice(s.db, m.id, { status: "submitted" });
    const [sub] = await s.db.insert(submissions).values({ invoiceId: inv.id, payer: OTHER, legs: [], status: "pending" }).returning();
    const ev = await chain.emitPaid(s.router, { invoiceId: inv.id as Hex, amountOut: AMOUNT });
    s.start();
    await waitCursorPast(s.db, ev.block);
    const [p] = await s.db.select().from(payments).where(eq(payments.invoiceId, inv.id));
    expect(p?.legs).toBeNull();
    const [sub2] = await s.db.select().from(submissions).where(eq(submissions.id, sub!.id));
    expect(sub2?.status).toBe("failed");
    expect(sub2?.error).toMatch(/superseded/);
  });

  it("is idempotent: re-scanning the same range adds nothing and never re-notifies", async () => {
    const s = await setup();
    const m = await seedMerchant(s.db);
    const inv = await seedInvoice(s.db, m.id);
    const unknown = randomInvoiceId();
    const ev = await chain.emitPaid(s.router, { invoiceId: inv.id as Hex, amountOut: AMOUNT });
    await chain.emitPaid(s.router, { invoiceId: unknown, amountOut: 1n });
    const ix = s.start();
    const head = await chain.publicClient.getBlockNumber({ cacheTime: 0 });
    await waitCursorPast(s.db, head);
    await waitFor(async () => s.notifier.paid.length === 1, 15_000, "notify");
    await ix.stop();

    // Rewind the cursor to the deploy block and run again (e.g. operator replay after an incident).
    await s.db.update(chainCursor).set({ blockNumber: s.fromBlock }).where(eq(chainCursor.id, CURSOR_ID));
    s.start();
    await chain.testClient.mine({ blocks: 1 });
    await waitCursorPast(s.db, head + 1n);
    await sleep(100);

    expect(await s.db.select().from(payments)).toHaveLength(1);
    expect(await s.db.select().from(unmatchedEvents)).toHaveLength(1);
    expect(s.notifier.paid).toHaveLength(1);
    expect((await invoiceOf(s.db, inv.id)).status).toBe("paid");
    expect(ev.txHash).toBe(s.notifier.paid[0]!.txHash);
  });

  it("restarts from the stored cursor (no rescan from fromBlock)", async () => {
    const s = await setup();
    const m = await seedMerchant(s.db);
    const a = await seedInvoice(s.db, m.id);
    const b = await seedInvoice(s.db, m.id);
    const evA = await chain.emitPaid(s.router, { invoiceId: a.id as Hex, amountOut: AMOUNT });
    const ix = s.start();
    await waitCursorPast(s.db, evA.block);
    await ix.stop();
    const stored = (await cursorOf(s.db))!;

    const evB = await chain.emitPaid(s.router, { invoiceId: b.id as Hex, amountOut: AMOUNT });
    s.calls.length = 0;
    s.start();
    await waitCursorPast(s.db, evB.block);
    const firstLogs = s.calls.find((c) => c.method === "eth_getLogs")!;
    expect(BigInt((firstLogs.params as [{ fromBlock: Hex }])[0].fromBlock)).toBe(stored);
    expect((await invoiceOf(s.db, b.id)).status).toBe("paid");
    await waitFor(async () => s.notifier.paid.length === 2, 15_000, "2 notifications");
    expect(s.notifier.paid.map((x) => x.invoiceId).sort()).toEqual([a.id, b.id].sort());
  });

  it("term mismatch and unknown invoice go to unmatched_events; invoice untouched", async () => {
    const s = await setup();
    const m = await seedMerchant(s.db);
    const inv = await seedInvoice(s.db, m.id);
    const unknown = randomInvoiceId();
    await chain.emitPaid(s.router, { invoiceId: inv.id as Hex, amountOut: AMOUNT - 1n });
    await chain.emitPaid(s.router, { invoiceId: inv.id as Hex, amountOut: AMOUNT, merchant: OTHER });
    await chain.emitPaid(s.router, { invoiceId: inv.id as Hex, amountOut: AMOUNT, tokenOut: WBRL });
    const evU = await chain.emitPaid(s.router, { invoiceId: unknown, amountOut: 5n });
    s.start();
    await waitCursorPast(s.db, evU.block);

    const rows = await s.db.select().from(unmatchedEvents);
    expect(rows.map((r) => r.reason).sort()).toEqual(["term_mismatch", "term_mismatch", "term_mismatch", "unknown_invoice"]);
    const fields = rows.filter((r) => r.reason === "term_mismatch").map((r) => (r.payload as { mismatches: { field: string }[] }).mismatches[0]!.field);
    expect(fields.sort()).toEqual(["amountOut", "merchant", "tokenOut"]);
    expect((rows.find((r) => r.reason === "unknown_invoice")!.payload as { amountOut: string }).amountOut).toBe("5");
    expect((await invoiceOf(s.db, inv.id)).status).toBe("open");
    expect(await s.db.select().from(payments)).toEqual([]);
    expect(s.notifier.paid).toEqual([]);
    expect(s.notifier.texts).toEqual([]); // no merchant spam for foreign/griefing events
  });

  it("expired-but-on-time is paid; late/cancelled/double payment: recorded, merchant alerted once, never dropped", async () => {
    const s = await setup();
    const m = await seedMerchant(s.db, { language: "pt", currency: "BRL" });
    const onTime = await seedInvoice(s.db, m.id, { status: "expired" }); // expiry job ran before indexing
    const late = await seedInvoice(s.db, m.id, { status: "expired", expiresAt: new Date(Date.now() - 3_600_000) });
    const cancelled = await seedInvoice(s.db, m.id, { status: "cancelled" });
    const twice = await seedInvoice(s.db, m.id);
    await chain.emitPaid(s.router, { invoiceId: onTime.id as Hex, amountOut: AMOUNT });
    await chain.emitPaid(s.router, { invoiceId: late.id as Hex, amountOut: AMOUNT });
    await chain.emitPaid(s.router, { invoiceId: cancelled.id as Hex, amountOut: AMOUNT });
    await chain.emitPaid(s.router, { invoiceId: twice.id as Hex, amountOut: AMOUNT });
    const last = await chain.emitPaid(s.router, { invoiceId: twice.id as Hex, amountOut: AMOUNT });
    s.start();
    await waitCursorPast(s.db, last.block);
    await waitFor(async () => s.notifier.texts.length === 3 && s.notifier.paid.length === 2, 15_000, "alerts");

    const reasons = (await s.db.select().from(unmatchedEvents)).map((r) => r.reason).sort();
    expect(reasons).toEqual(["already_paid", "paid_while_cancelled", "paid_while_expired"]);
    expect((await invoiceOf(s.db, onTime.id)).status).toBe("paid");
    expect((await invoiceOf(s.db, late.id)).status).toBe("expired");
    expect(s.notifier.texts.every((t) => t.merchantId === m.id && /Você recebeu/.test(t.message))).toBe(true);
    expect(s.logs.filter((l) => l.msg === "indexer_alert_merchant_paid_unmatched")).toHaveLength(3);
  });

  it("waits for confirmations before applying", async () => {
    const s = await setup();
    const m = await seedMerchant(s.db);
    const inv = await seedInvoice(s.db, m.id);
    const ev = await chain.emitPaid(s.router, { invoiceId: inv.id as Hex, amountOut: AMOUNT });
    s.start({ confirmations: 5 });
    await sleep(300);
    expect((await invoiceOf(s.db, inv.id)).status).toBe("open");
    expect((await cursorOf(s.db)) ?? s.fromBlock).toBeLessThanOrEqual(ev.block);
    await chain.testClient.mine({ blocks: 4 });
    await sleep(300);
    expect((await invoiceOf(s.db, inv.id)).status).toBe("open"); // head = ev + 4 < ev + 5
    await chain.testClient.mine({ blocks: 1 });
    await waitFor(async () => (await invoiceOf(s.db, inv.id)).status === "paid", 15_000, "paid after 5 confs");
    const safe = (await chain.publicClient.getBlockNumber({ cacheTime: 0 })) - 5n;
    expect(await cursorOf(s.db)).toBeLessThanOrEqual(safe + 1n);
  });

  it("halves the block range when the provider rejects it, and still sees every log", async () => {
    const s = await setup();
    const m = await seedMerchant(s.db);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const inv = await seedInvoice(s.db, m.id);
      ids.push(inv.id);
      await chain.emitPaid(s.router, { invoiceId: inv.id as Hex, amountOut: AMOUNT });
      await chain.testClient.mine({ blocks: 15 });
    }
    s.start({ maxBlockRange: 2000, maxLogsRange: 10 });
    const head = await chain.publicClient.getBlockNumber({ cacheTime: 0 });
    await waitCursorPast(s.db, head);

    for (const id of ids) expect((await invoiceOf(s.db, id)).status).toBe("paid");
    expect(s.logs.some((l) => l.msg === "indexer_range_shrunk")).toBe(true);
    const spans = s.calls
      .filter((c) => c.method === "eth_getLogs")
      .map((c) => {
        const [f] = c.params as [{ fromBlock: Hex; toBlock: Hex }];
        return BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n;
      });
    expect(spans[0]).toBeGreaterThan(10n);
    expect(spans.at(-1)!).toBeLessThanOrEqual(10n); // settled on a size the provider accepts
  });

  it("notifier failure does not block the cursor; the outbox retries until delivered exactly once", async () => {
    const s = await setup();
    const m = await seedMerchant(s.db);
    const a = await seedInvoice(s.db, m.id);
    const b = await seedInvoice(s.db, m.id);
    s.notifier.failNext = 1_000;
    await chain.emitPaid(s.router, { invoiceId: a.id as Hex, amountOut: AMOUNT });
    const evB = await chain.emitPaid(s.router, { invoiceId: b.id as Hex, amountOut: AMOUNT });
    const ix = s.start();
    await waitCursorPast(s.db, evB.block);
    await ix.stop();

    expect((await invoiceOf(s.db, a.id)).status).toBe("paid");
    expect((await invoiceOf(s.db, b.id)).status).toBe("paid");
    const pending = await listOutbox(s.db);
    expect(pending).toHaveLength(2);
    expect(pending.every((e) => e.value.attempts >= 1 && e.value.lastError === "telegram down")).toBe(true);
    expect(s.notifier.paid).toEqual([]);

    // Telegram recovers; a later drain (as the loop does each tick) delivers each exactly once.
    s.notifier.failNext = 0;
    const later = new Date(Date.now() + 10 * 60_000);
    expect(await drainOutbox(s.db, s.notifier, later, () => {})).toEqual({ sent: 2, failed: 0 });
    expect(await drainOutbox(s.db, s.notifier, later, () => {})).toEqual({ sent: 0, failed: 0 });
    expect(s.notifier.paid.map((p) => p.invoiceId).sort()).toEqual([a.id, b.id].sort());
    expect(await listOutbox(s.db)).toEqual([]);
  });

  it("backs off on generic RPC errors and recovers without losing the block", async () => {
    const s = await setup();
    const m = await seedMerchant(s.db);
    const inv = await seedInvoice(s.db, m.id);
    const ev = await chain.emitPaid(s.router, { invoiceId: inv.id as Hex, amountOut: AMOUNT });
    s.start({ faults: { method: "eth_getBlockByNumber", remaining: 1 } }); // timestamp fetch fails once
    await waitFor(async () => (await invoiceOf(s.db, inv.id)).status === "paid", 15_000, "paid after retry");
    const errs = s.logs.filter((l) => l.msg === "indexer_error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.extra).toMatchObject({ retryInMs: 1000 });
    expect(await s.db.select().from(payments)).toHaveLength(1);
    expect((await cursorOf(s.db))!).toBeGreaterThan(ev.block);
  });

  it("stop() resolves promptly and no RPC call happens afterwards", async () => {
    const s = await setup();
    const ix = s.start();
    await waitFor(async () => (await cursorOf(s.db)) !== undefined, 15_000, "cursor created");
    const t0 = Date.now();
    await ix.stop();
    expect(Date.now() - t0).toBeLessThan(2000);
    const n = s.calls.length;
    await sleep(150);
    expect(s.calls.length).toBe(n);
  });
});

describe("applyBatch", () => {
  it("refuses to apply when another writer moved the cursor (concurrent indexers)", async () => {
    const db = await freshDb();
    await db.insert(chainCursor).values({ id: CURSOR_ID, blockNumber: 100n });
    await expect(applyBatch(db, [], 50n, 60n, () => {})).rejects.toBeInstanceOf(CursorMovedError);
    expect(await cursorOf(db)).toBe(100n);
    await applyBatch(db, [], 100n, 110n, () => {});
    expect(await cursorOf(db)).toBe(111n);
  });

  it("rolls the whole batch back if one log fails (cursor unchanged)", async () => {
    const db = await freshDb();
    const m = await seedMerchant(db);
    const inv = await seedInvoice(db, m.id);
    await db.insert(chainCursor).values({ id: CURSOR_ID, blockNumber: 1n });
    const good = { invoiceId: inv.id as Hex, payer: PAYER, merchant: MERCHANT, tokenOut: WARS, amountOut: AMOUNT, txHash: `0x${"aa".repeat(32)}` as Hex, logIndex: 0, blockNumber: 1n, blockTimestamp: 1_800_000_000n };
    const bad = { ...good, invoiceId: "0xnot-hex" as Hex, logIndex: 1, blockTimestamp: -1n as bigint, txHash: null as unknown as Hex };
    await expect(applyBatch(db, [good, bad], 1n, 5n, () => {})).rejects.toThrow();
    expect(await cursorOf(db)).toBe(1n);
    expect(await db.select().from(payments)).toEqual([]);
    expect((await invoiceOf(db, inv.id)).status).toBe("open");
    expect(await listOutbox(db)).toEqual([]);
  });
});

describe("expireInvoices", () => {
  it("expires only open invoices past expiresAt and returns the count", async () => {
    const db = await freshDb();
    const m = await seedMerchant(db);
    const now = new Date("2026-11-02T12:00:00Z");
    const past = new Date(now.getTime() - 1);
    const openPast = await seedInvoice(db, m.id, { expiresAt: past });
    const openPast2 = await seedInvoice(db, m.id, { expiresAt: new Date(now.getTime() - 3_600_000) });
    const openExact = await seedInvoice(db, m.id, { expiresAt: now }); // deadline is inclusive on-chain
    const openFuture = await seedInvoice(db, m.id, { expiresAt: new Date(now.getTime() + 1) });
    const submittedPast = await seedInvoice(db, m.id, { expiresAt: past, status: "submitted" });
    const paidPast = await seedInvoice(db, m.id, { expiresAt: past, status: "paid" });

    expect(await expireInvoices(db, now)).toBe(2);
    expect(await expireInvoices(db, now)).toBe(0);
    const status = async (id: string) => (await invoiceOf(db, id)).status;
    expect(await status(openPast.id)).toBe("expired");
    expect(await status(openPast2.id)).toBe("expired");
    expect(await status(openExact.id)).toBe("open");
    expect(await status(openFuture.id)).toBe("open");
    expect(await status(submittedPast.id)).toBe("submitted");
    expect(await status(paidPast.id)).toBe("paid");
  });
});

describe("startIndexer — two routers (v1 legacy + v2)", () => {
  it("follows Paid logs from both routers with one cursor; ignores a third contract", async () => {
    const db = await freshDb();
    const v1 = await chain.deployEmitter();
    const v2 = await chain.deployEmitter();
    const stranger = await chain.deployEmitter();
    const m = await seedMerchant(db);
    const [i1, i2, i3] = [await seedInvoice(db, m.id), await seedInvoice(db, m.id), await seedInvoice(db, m.id)];
    const e1 = await chain.emitPaid(v1.address, { invoiceId: i1.id as Hex, amountOut: AMOUNT });
    const e2 = await chain.emitPaid(v2.address, { invoiceId: i2.id as Hex, amountOut: AMOUNT });
    const e3 = await chain.emitPaid(stranger.address, { invoiceId: i3.id as Hex, amountOut: AMOUNT });
    const notifier = new RecordingNotifier();
    const { publicClient } = makeClients(anvil.url);
    const ix = startIndexer({
      db,
      publicClient,
      router: v2.address,
      fromBlock: v2.block,
      legacyRouter: { address: v1.address, fromBlock: v1.block },
      confirmations: 0,
      pollIntervalMs: 20,
      notifier,
      log: () => {},
    });
    running.push(ix);
    await waitCursorPast(db, e3.block);
    expect((await invoiceOf(db, i1.id)).status).toBe("paid");
    expect((await invoiceOf(db, i2.id)).status).toBe("paid");
    expect((await invoiceOf(db, i3.id)).status).toBe("open");
    const rows = await db.select().from(payments);
    expect(rows.map((r) => r.txHash).sort()).toEqual([e1.txHash, e2.txHash].sort());
  });

  it("without legacyRouter only the configured router is followed (v1 behaviour)", async () => {
    const db = await freshDb();
    const v1 = await chain.deployEmitter();
    const v2 = await chain.deployEmitter();
    const m = await seedMerchant(db);
    const i1 = await seedInvoice(db, m.id);
    const e1 = await chain.emitPaid(v1.address, { invoiceId: i1.id as Hex, amountOut: AMOUNT });
    const { publicClient } = makeClients(anvil.url);
    const ix = startIndexer({ db, publicClient, router: v2.address, fromBlock: v1.block, confirmations: 0, pollIntervalMs: 20, log: () => {} });
    running.push(ix);
    await waitCursorPast(db, e1.block);
    expect((await invoiceOf(db, i1.id)).status).toBe("open");
  });
});
