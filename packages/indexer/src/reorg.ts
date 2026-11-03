/**
 * WS7-4 reorg guard.
 *
 * The log loop only trusts blocks `confirmations` deep, but a deeper sequencer/L1-driven reorg can still drop a
 * block that already produced a `payments` row. Waiting for `finalized` would add minutes of merchant latency,
 * so instead we keep the fast path and RE-VERIFY recent payments: for every payment whose block is within
 * `window` blocks of head, the receipt must still exist, be successful and still carry the matching `Paid` log.
 *
 *  - receipt present, same Paid log, other block   -> payment row follows the new block number;
 *  - receipt missing / reverted / no matching log  -> payment removed, invoice un-paid, cursor rewound to the
 *    payment block so the loop re-scans (a re-included tx is applied again by the normal path, idempotently).
 *
 * False-positive protection (the production RPC is a load-balanced public endpoint; one lagging backend can answer
 * "receipt not found" for a final tx). A negative verdict only counts if (1) the node's head is at least
 * `confirmations` past the payment block, (2) it was seen on `requiredMisses` consecutive checks at least
 * `minSuspectGapMs` apart (counter in `flags`, `reorg_suspect:<txHash>`, cleared by any positive answer), and
 * (3) on the last check a second read of the block at the payment height no longer lists the tx.
 * RPC errors never revert anything.
 */
import { and, eq, gt } from "drizzle-orm";
import { parseEventLogs, TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient } from "viem";
import { chainCursor, flags, invoices, merchants, payments, submissions, type Db } from "@cobra/db";
import { cobraRouterAbi, type Language } from "@cobra/shared";
import { enqueue } from "./outbox";
import { CURSOR_ID } from "./reconcile";
import { errorMessage } from "./rpc-errors";

export const SUSPECT_PREFIX = "reorg_suspect:";
export const DEFAULT_REQUIRED_MISSES = 3;
export const DEFAULT_MIN_SUSPECT_GAP_MS = 30_000;

type Log = (msg: string, extra?: Record<string, unknown>) => void;

export interface ReorgCheckResult {
  checked: number;
  moved: number;
  reverted: number;
  /** Lowest block the cursor was rewound to (undefined when nothing was reverted). */
  rewoundTo?: bigint;
}

export async function verifyRecentPayments(o: {
  db: Db;
  publicClient: PublicClient;
  router: Address;
  head: bigint;
  window: number;
  confirmations?: number;
  requiredMisses?: number;
  minSuspectGapMs?: number;
  log: Log;
  now?: Date;
}): Promise<ReorgCheckResult> {
  const { db, publicClient, router, log } = o;
  const now = o.now ?? new Date();
  const confirmations = BigInt(o.confirmations ?? 0);
  const requiredMisses = o.requiredMisses ?? DEFAULT_REQUIRED_MISSES;
  const minGap = o.minSuspectGapMs ?? DEFAULT_MIN_SUSPECT_GAP_MS;
  const res: ReorgCheckResult = { checked: 0, moved: 0, reverted: 0 };
  const floor = o.head > BigInt(o.window) ? o.head - BigInt(o.window) : 0n;
  const recent = await db.select().from(payments).where(gt(payments.blockNumber, floor));
  for (const p of recent) {
    res.checked++;
    let verdict: { ok: true; block: bigint } | { ok: false; why: string };
    try {
      const rcpt = await publicClient.getTransactionReceipt({ hash: p.txHash as Hex });
      const paid = parseEventLogs({ abi: cobraRouterAbi, eventName: "Paid", logs: rcpt.logs }).find(
        (l) => l.address.toLowerCase() === router.toLowerCase() && l.args.invoiceId.toLowerCase() === p.invoiceId.toLowerCase(),
      );
      verdict =
        rcpt.status === "success" && paid
          ? { ok: true, block: rcpt.blockNumber }
          : { ok: false, why: rcpt.status === "success" ? "no_paid_log" : "reverted" };
    } catch (e) {
      if (!(e instanceof TransactionReceiptNotFoundError)) {
        log("indexer_reorg_check_error", { level: "warn", txHash: p.txHash, error: errorMessage(e) });
        continue; // unknown: never revert on an RPC hiccup
      }
      verdict = { ok: false, why: "receipt_missing" };
    }
    const suspectKey = `${SUSPECT_PREFIX}${p.txHash.toLowerCase()}`;
    if (verdict.ok) {
      await db.delete(flags).where(eq(flags.key, suspectKey)); // any positive answer clears the suspicion
      if (verdict.block !== p.blockNumber) {
        await db.update(payments).set({ blockNumber: verdict.block }).where(eq(payments.id, p.id));
        res.moved++;
        log("indexer_reorg_payment_moved", {
          level: "warn",
          invoiceId: p.invoiceId,
          txHash: p.txHash,
          from: p.blockNumber.toString(),
          to: verdict.block.toString(),
        });
      }
      continue;
    }
    // 1. the node must itself be caught up past the payment block
    let nodeHead: bigint;
    try {
      nodeHead = await publicClient.getBlockNumber({ cacheTime: 0 });
    } catch (e) {
      log("indexer_reorg_check_error", { level: "warn", txHash: p.txHash, error: errorMessage(e) });
      continue;
    }
    if (nodeHead < p.blockNumber + confirmations) {
      log("indexer_reorg_node_behind", { level: "warn", txHash: p.txHash, nodeHead: nodeHead.toString(), block: p.blockNumber.toString() });
      continue;
    }
    // 2. consecutive misses, spaced apart
    const [prev] = await db.select().from(flags).where(eq(flags.key, suspectKey));
    const pv = prev?.value as { count?: number; firstSeen?: string; lastSeen?: string } | undefined;
    let count = 1;
    if (pv && typeof pv.count === "number" && pv.lastSeen) {
      if (now.getTime() - new Date(pv.lastSeen).getTime() < minGap) continue; // too soon: not an independent observation
      count = pv.count + 1;
    }
    const value = { count, firstSeen: pv?.firstSeen ?? now.toISOString(), lastSeen: now.toISOString(), why: verdict.why };
    await db
      .insert(flags)
      .values({ key: suspectKey, value })
      .onConflictDoUpdate({ target: flags.key, set: { value, updatedAt: now } });
    log("indexer_reorg_suspect", { level: "warn", txHash: p.txHash, count, why: verdict.why });
    if (count < requiredMisses) continue;
    // 3. final confirmation: the block at that height must no longer list the tx
    try {
      const blk = await publicClient.getBlock({ blockNumber: p.blockNumber, includeTransactions: false });
      if ((blk.transactions as Hex[]).some((t) => t.toLowerCase() === p.txHash.toLowerCase())) continue;
    } catch (e) {
      log("indexer_reorg_check_error", { level: "warn", txHash: p.txHash, error: errorMessage(e) });
      continue;
    }
    const rewound = await revertPayment(db, p, verdict.why, now);
    await db.delete(flags).where(eq(flags.key, suspectKey));
    if (rewound === null) continue; // someone else already handled it
    res.reverted++;
    res.rewoundTo = res.rewoundTo === undefined || rewound < res.rewoundTo ? rewound : res.rewoundTo;
    log("indexer_alert_reorg_payment_reverted", {
      level: "alert",
      invoiceId: p.invoiceId,
      txHash: p.txHash,
      block: p.blockNumber.toString(),
      why: verdict.why,
    });
  }
  return res;
}

/** Returns the block the cursor was rewound to, or null when the payment row was already gone. */
async function revertPayment(db: Db, p: typeof payments.$inferSelect, why: string, now: Date): Promise<bigint | null> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, p.invoiceId)).for("update");
    const deleted = await tx.delete(payments).where(eq(payments.id, p.id)).returning({ id: payments.id });
    if (deleted.length === 0 || !inv) return null;

    // The relayer's own submission (confirmed by this tx) goes back to `sent`: its watcher re-broadcasts / replaces
    // on the same nonce, exactly like a dropped transaction.
    const restored = await tx
      .update(submissions)
      .set({ status: "sent", error: `reorged:${why}`, updatedAt: now })
      .where(and(eq(submissions.invoiceId, inv.id), eq(submissions.status, "confirmed"), eq(submissions.txHash, p.txHash)))
      .returning({ id: submissions.id });
    // `paid` has no outgoing transition in the frozen state machine; this is the one sanctioned exception
    // (the payment no longer exists on-chain), done as a guarded direct update.
    const status = restored.length > 0 ? "submitted" : inv.expiresAt.getTime() > now.getTime() ? "open" : "expired";
    await tx
      .update(invoices)
      .set({ status, paidAt: null })
      .where(and(eq(invoices.id, inv.id), eq(invoices.status, "paid")));

    // (deliberately NOT recorded in unmatched_events: that table is keyed by tx/log and would make a re-included tx a "duplicate")
    const [m] = await tx.select({ language: merchants.language }).from(merchants).where(eq(merchants.id, inv.merchantId));
    await enqueue(
      tx,
      `outbox:reorg:${p.txHash.toLowerCase()}:${p.logIndex}`,
      { kind: "text", merchantId: inv.merchantId, message: reorgText((m?.language ?? "es") as Language, inv.reference ?? inv.id.slice(0, 10)) },
      now,
    );

    // Re-scan from the payment block (applyBatch is idempotent; a re-included tx is applied again).
    await tx
      .update(chainCursor)
      .set({ blockNumber: p.blockNumber, updatedAt: now })
      .where(and(eq(chainCursor.id, CURSOR_ID), gt(chainCursor.blockNumber, p.blockNumber)));
    return p.blockNumber;
  });
}

function reorgText(lang: Language, ref: string): string {
  if (lang === "pt") {
    return `Atenção: o pagamento da ref ${ref} foi desfeito por uma reorganização da rede. Ainda não conte esse valor como recebido; avisaremos se ele for confirmado novamente.`;
  }
  if (lang === "en") {
    return `Heads up: the payment for ref ${ref} was undone by a network reorg. Do not count it as received yet; we will tell you if it confirms again.`;
  }
  return `Atención: el pago de la ref ${ref} fue deshecho por una reorganización de la red. No lo cuentes como recibido todavía; te avisaremos si se confirma de nuevo.`;
}
