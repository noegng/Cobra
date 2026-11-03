import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { TransactionReceiptNotFoundError, encodeAbiParameters, keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import { flags, invoices, payments, type Db } from "@cobra/db";
import { SUSPECT_PREFIX, verifyRecentPayments } from "../src/reorg";
import { MERCHANT, PAYER, RecordingNotifier, WARS, freshDb, seedInvoice, seedMerchant } from "./helpers";
import { drainOutbox, listOutbox } from "../src/index";

const ROUTER: Address = "0x00000000000000000000000000000000000000a1";
const TX: Hex = `0x${"ab".repeat(32)}`;
const BLOCK = 1000n;
const AMOUNT = 4500n * 10n ** 18n;
const GAP = 30_000;

// Paid(bytes32 indexed invoiceId, address indexed payer, address indexed merchant, address tokenOut, uint256 amountOut)
async function seedPaid(db: Db) {
  const m = await seedMerchant(db);
  const inv = await seedInvoice(db, m.id, { status: "paid", paidAt: new Date() });
  await db.insert(payments).values({
    invoiceId: inv.id,
    txHash: TX,
    logIndex: 0,
    payer: PAYER,
    tokenOut: WARS,
    amountOut: AMOUNT.toString(),
    blockNumber: BLOCK,
    paidAt: new Date(),
  });
  return inv;
}

interface Fake {
  receipt: "missing" | "error" | "ok";
  head: bigint;
  blockTxs: Hex[] | "error";
}

function fakeClient(f: Fake, invoiceId: Hex): PublicClient {
  const topicPaid = keccak256(toHex("Paid(bytes32,address,address,address,uint256)"));
  const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
  return {
    async getBlockNumber() {
      return f.head;
    },
    async getTransactionReceipt() {
      if (f.receipt === "missing") throw new TransactionReceiptNotFoundError({ hash: TX });
      if (f.receipt === "error") throw new Error("upstream connect error");
      return {
        status: "success",
        blockNumber: BLOCK,
        logs: [
          {
            address: ROUTER,
            topics: [topicPaid, invoiceId, pad(PAYER), pad(MERCHANT)],
            data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [WARS, AMOUNT]),
            blockNumber: BLOCK,
            transactionHash: TX,
            logIndex: 0,
          },
        ],
      };
    },
    async getBlock() {
      if (f.blockTxs === "error") throw new Error("block read failed");
      return { transactions: f.blockTxs };
    },
  } as unknown as PublicClient;
}

describe("reorg guard false-positive protection", () => {
  const run = (db: Db, f: Fake, invId: Hex, nowMs: number, log: unknown[] = []) =>
    verifyRecentPayments({
      db,
      publicClient: fakeClient(f, invId),
      router: ROUTER,
      head: f.head,
      window: 600,
      confirmations: 5,
      minSuspectGapMs: GAP,
      log: (m, x) => log.push({ m, ...x }),
      now: new Date(nowMs),
    });
  const status = async (db: Db, id: string) => (await db.select().from(invoices).where(eq(invoices.id, id)))[0]!.status;
  const suspect = async (db: Db) => (await db.select().from(flags).where(eq(flags.key, `${SUSPECT_PREFIX}${TX}`)))[0];

  it("one transient miss then success: nothing reverted, counter cleared", async () => {
    const db = await freshDb();
    const inv = await seedPaid(db);
    const f: Fake = { receipt: "missing", head: BLOCK + 50n, blockTxs: [] };
    const t0 = Date.now();
    expect((await run(db, f, inv.id as Hex, t0)).reverted).toBe(0);
    expect((await suspect(db))?.value).toMatchObject({ count: 1 });
    f.receipt = "ok";
    expect((await run(db, f, inv.id as Hex, t0 + GAP + 1)).reverted).toBe(0);
    expect(await suspect(db)).toBeUndefined();
    expect(await status(db, inv.id)).toBe("paid");
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it("node behind: skipped, no counter, no revert", async () => {
    const db = await freshDb();
    const inv = await seedPaid(db);
    const f: Fake = { receipt: "missing", head: BLOCK + 2n, blockTxs: [] }; // < block + 5 confirmations
    const log: unknown[] = [];
    for (let i = 0; i < 5; i++) await run(db, f, inv.id as Hex, Date.now() + i * (GAP + 1), log);
    expect(await suspect(db)).toBeUndefined();
    expect(await status(db, inv.id)).toBe("paid");
    expect(log.some((l) => (l as { m: string }).m === "indexer_reorg_node_behind")).toBe(true);
  });

  it("RPC errors and a failing block read never revert", async () => {
    const db = await freshDb();
    const inv = await seedPaid(db);
    const t0 = Date.now();
    await run(db, { receipt: "error", head: BLOCK + 50n, blockTxs: [] }, inv.id as Hex, t0);
    expect(await suspect(db)).toBeUndefined();
    const f: Fake = { receipt: "missing", head: BLOCK + 50n, blockTxs: "error" };
    for (let i = 0; i < 4; i++) await run(db, f, inv.id as Hex, t0 + i * (GAP + 1));
    expect(await status(db, inv.id)).toBe("paid");
  });

  it("misses closer than the minimum gap count once; a block that still lists the tx blocks the revert", async () => {
    const db = await freshDb();
    const inv = await seedPaid(db);
    const t0 = Date.now();
    const f: Fake = { receipt: "missing", head: BLOCK + 50n, blockTxs: [TX] };
    await run(db, f, inv.id as Hex, t0);
    await run(db, f, inv.id as Hex, t0 + 1000);
    expect((await suspect(db))?.value).toMatchObject({ count: 1 });
    await run(db, f, inv.id as Hex, t0 + GAP + 1);
    await run(db, f, inv.id as Hex, t0 + 2 * GAP + 2);
    expect((await suspect(db))?.value).toMatchObject({ count: 3 });
    expect(await status(db, inv.id)).toBe("paid"); // second read still shows the tx
  });

  it("3 consecutive misses confirmed by the block read: reverted once, one alert", async () => {
    const db = await freshDb();
    const inv = await seedPaid(db);
    const t0 = Date.now();
    const f: Fake = { receipt: "missing", head: BLOCK + 50n, blockTxs: [] };
    expect((await run(db, f, inv.id as Hex, t0)).reverted).toBe(0);
    expect((await run(db, f, inv.id as Hex, t0 + GAP + 1)).reverted).toBe(0);
    expect(await status(db, inv.id)).toBe("paid");
    expect((await run(db, f, inv.id as Hex, t0 + 2 * GAP + 2)).reverted).toBe(1);
    expect(await status(db, inv.id)).not.toBe("paid");
    expect(await db.select().from(payments)).toHaveLength(0);
    expect(await suspect(db)).toBeUndefined();
    // nothing left to re-verify: no second revert, no second alert
    expect((await run(db, f, inv.id as Hex, t0 + 3 * GAP + 3)).reverted).toBe(0);
    expect((await listOutbox(db)).filter((o) => o.key.includes("reorg"))).toHaveLength(1);
    const n = new RecordingNotifier();
    await drainOutbox(db, n, new Date(Date.now() + 600_000), () => {});
    expect(n.texts.filter((t) => /reorg/i.test(t.message))).toHaveLength(1);
  });
});
