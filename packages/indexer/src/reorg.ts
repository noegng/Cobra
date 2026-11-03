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
 * RPC errors never revert anything (only a definitive "no such receipt" does).
 */
import { and, eq, gt } from "drizzle-orm";
import { parseEventLogs, TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient } from "viem";
import { chainCursor, invoices, merchants, payments, submissions, type Db } from "@cobra/db";
import { cobraRouterAbi, type Language } from "@cobra/shared";
import { enqueue } from "./outbox";
import { CURSOR_ID } from "./reconcile";
import { errorMessage } from "./rpc-errors";

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
  log: Log;
  now?: Date;
}): Promise<ReorgCheckResult> {
  const { db, publicClient, router, log } = o;
  const now = o.now ?? new Date();
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
    if (verdict.ok) {
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
    const rewound = await revertPayment(db, p, verdict.why, now);
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
