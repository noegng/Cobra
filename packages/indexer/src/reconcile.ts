/**
 * Reconciliation of `Paid` logs against Postgres (docs/interfaces.md §5).
 * `applyBatch` runs ONE transaction per block range: every log + the cursor move commit together.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getAddress, type Address, type Hex } from "viem";
import {
  chainCursor,
  invoices,
  merchants,
  payments,
  quotes,
  submissions,
  transitionInvoice,
  unmatchedEvents,
  type Db,
  type InvoiceRow,
} from "@cobra/db";
import { explorerTx, type Currency, type Language, type SerializedPlan } from "@cobra/shared";
import { alertKey, enqueue, invoicePaidKey } from "./outbox";

export const CURSOR_ID = "router_paid";

/** A decoded, confirmed `Paid` log. */
export interface PaidLog {
  invoiceId: Hex;
  payer: Address;
  merchant: Address;
  tokenOut: Address;
  amountOut: bigint;
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  blockTimestamp: bigint; // unix seconds
}

export type UnmatchedReason =
  | "unknown_invoice"
  | "term_mismatch"
  | "already_paid" // terms match but the invoice already has a payment from another log: merchant was paid twice
  | "paid_while_expired" // terms match, merchant received the money, but the DB says expired
  | "paid_while_cancelled"; // same, cancelled

/** Reasons where the merchant really received `amountOut` for one of their invoices: alert, never drop. */
const MERCHANT_RECEIVED: ReadonlySet<UnmatchedReason> = new Set(["already_paid", "paid_while_expired", "paid_while_cancelled"]);

export type LogOutcome =
  | { kind: "paid"; invoiceId: string }
  | { kind: "unmatched"; reason: UnmatchedReason }
  | { kind: "duplicate" }; // already processed (idempotent re-run)

export interface BatchResult {
  outcomes: LogOutcome[];
  enqueued: number;
}

export class CursorMovedError extends Error {
  constructor(expected: bigint, actual: bigint | undefined) {
    super(`cursor ${CURSOR_ID} moved: expected ${expected}, found ${actual ?? "none"} (another indexer running?)`);
  }
}

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** Returns the next block to scan, creating the cursor at `fromBlock` on first run. */
export async function loadCursor(db: Db, fromBlock: bigint): Promise<bigint> {
  await db.insert(chainCursor).values({ id: CURSOR_ID, blockNumber: fromBlock }).onConflictDoNothing();
  const [row] = await db.select().from(chainCursor).where(eq(chainCursor.id, CURSOR_ID));
  if (!row) throw new Error("cursor row missing after insert");
  return row.blockNumber < fromBlock ? fromBlock : row.blockNumber;
}

/**
 * Apply all logs of [from, to] and move the cursor to `to + 1`, atomically.
 * Throws CursorMovedError if the stored cursor is ahead of `from` (concurrent indexer) — nothing is written.
 */
export async function applyBatch(db: Db, logs: readonly PaidLog[], from: bigint, to: bigint, log: Log, now = new Date()): Promise<BatchResult> {
  const sorted = [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  const result = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [cur] = await tx.select().from(chainCursor).where(eq(chainCursor.id, CURSOR_ID)).for("update");
    // Cursor may legitimately be below `from` only when it was clamped up to fromBlock by loadCursor.
    if (cur && cur.blockNumber > from) throw new CursorMovedError(from, cur.blockNumber);
    const res: BatchResult = { outcomes: [], enqueued: 0 };
    for (const l of sorted) {
      const { outcome, enqueued } = await reconcileLog(tx, l, now);
      res.outcomes.push(outcome);
      if (enqueued) res.enqueued++;
    }
    await tx
      .insert(chainCursor)
      .values({ id: CURSOR_ID, blockNumber: to + 1n, updatedAt: now })
      .onConflictDoUpdate({ target: chainCursor.id, set: { blockNumber: to + 1n, updatedAt: now } });
    return res;
  });
  for (const [i, o] of result.outcomes.entries()) {
    const l = sorted[i]!;
    const ctx = { invoiceId: l.invoiceId, txHash: l.txHash, logIndex: l.logIndex, block: l.blockNumber.toString() };
    if (o.kind === "paid") log("indexer_invoice_paid", ctx);
    else if (o.kind === "unmatched") {
      const alert = MERCHANT_RECEIVED.has(o.reason);
      log(alert ? "indexer_alert_merchant_paid_unmatched" : "indexer_unmatched", { level: alert ? "alert" : "warn", reason: o.reason, ...ctx });
    }
  }
  return result;
}

async function reconcileLog(tx: Db, l: PaidLog, now: Date): Promise<{ outcome: LogOutcome; enqueued: boolean }> {
  // 1. Idempotency: this exact log was already applied or recorded.
  const [seenUnmatched] = await tx
    .select({ id: unmatchedEvents.id })
    .from(unmatchedEvents)
    .where(and(eq(unmatchedEvents.txHash, l.txHash), eq(unmatchedEvents.logIndex, l.logIndex)));
  if (seenUnmatched) return { outcome: { kind: "duplicate" }, enqueued: false };
  const [seenPayment] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.txHash, l.txHash), eq(payments.logIndex, l.logIndex)));
  if (seenPayment) return { outcome: { kind: "duplicate" }, enqueued: false };

  // 2. Lock the invoice row so web/relayer can't move it under us (e.g. open -> cancelled).
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, l.invoiceId.toLowerCase())).for("update");
  if (!inv) return unmatched(tx, l, "unknown_invoice", {}, null, now);

  const mismatches = termMismatches(inv, l);
  if (mismatches.length > 0) return unmatched(tx, l, "term_mismatch", { dbStatus: inv.status, mismatches }, null, now);

  const [existing] = await tx.select().from(payments).where(eq(payments.invoiceId, inv.id));
  if (existing || inv.status === "paid") {
    return unmatched(tx, l, "already_paid", { dbStatus: inv.status, firstPaymentTx: existing?.txHash ?? null }, inv, now);
  }
  // expired -> paid is legitimate when the payment block is within the invoice deadline (the router enforces
  // the deadline on-chain; the expiry job may simply have run first). A later block means the on-chain
  // Invoice carried a different deadline than the DB row: keep it out of the happy path.
  const deadline = BigInt(Math.floor(inv.expiresAt.getTime() / 1000));
  if (inv.status === "expired" && l.blockTimestamp > deadline) {
    return unmatched(tx, l, "paid_while_expired", { dbStatus: inv.status }, inv, now);
  }
  if (inv.status === "cancelled") return unmatched(tx, l, "paid_while_cancelled", { dbStatus: inv.status }, inv, now);

  // 3. open | submitted | expired(on time) -> paid.
  const paidAt = new Date(Number(l.blockTimestamp) * 1000);
  const [sub] = await tx
    .select()
    .from(submissions)
    .where(and(eq(submissions.invoiceId, inv.id), inArray(submissions.status, ["pending", "sending", "sent"])));
  const submissionPaid = !!sub && sub.payer.toLowerCase() === l.payer.toLowerCase();
  let plan: SerializedPlan | null = null;
  if (submissionPaid && sub.quoteId) {
    const [q] = await tx.select({ plan: quotes.plan }).from(quotes).where(eq(quotes.id, sub.quoteId));
    plan = (q?.plan as SerializedPlan | undefined) ?? null;
  }

  await tx.insert(payments).values({
    invoiceId: inv.id,
    txHash: l.txHash,
    logIndex: l.logIndex,
    payer: getAddress(l.payer),
    tokenOut: getAddress(l.tokenOut),
    amountOut: l.amountOut.toString(),
    legs: submissionPaid ? sub.legs : null,
    costBps: plan?.costBps ?? null,
    savingsBps: plan?.savingsBps ?? null,
    blockNumber: l.blockNumber,
    paidAt,
  });
  const moved = await transitionInvoice(tx, inv.id, ["open", "submitted", "expired"], "paid", { paidAt });
  if (!moved) throw new Error(`invoice ${inv.id} left ${inv.status} while locked`); // aborts the batch; retried

  if (sub) {
    await tx
      .update(submissions)
      .set(
        submissionPaid
          ? { status: "confirmed", txHash: l.txHash, error: null, updatedAt: now }
          : { status: "failed", error: `superseded: invoice paid on-chain by ${getAddress(l.payer)} in ${l.txHash}`, updatedAt: now },
      )
      .where(eq(submissions.id, sub.id));
  }

  const enqueued = await enqueue(
    tx,
    invoicePaidKey(inv.id),
    {
      kind: "invoicePaid",
      args: {
        merchantId: inv.merchantId,
        invoiceId: inv.id as Hex,
        amountLocal: inv.amountLocal,
        currency: inv.currency as Currency,
        reference: inv.reference,
        txHash: l.txHash,
      },
    },
    now,
  );
  return { outcome: { kind: "paid", invoiceId: inv.id }, enqueued };
}

function termMismatches(inv: InvoiceRow, l: PaidLog): { field: string; db: string; event: string }[] {
  const out: { field: string; db: string; event: string }[] = [];
  const addr = (s: string) => s.toLowerCase();
  if (addr(inv.merchantAddress) !== addr(l.merchant)) out.push({ field: "merchant", db: inv.merchantAddress, event: l.merchant });
  if (addr(inv.tokenOut) !== addr(l.tokenOut)) out.push({ field: "tokenOut", db: inv.tokenOut, event: l.tokenOut });
  if (BigInt(inv.amountOut) !== l.amountOut) out.push({ field: "amountOut", db: inv.amountOut, event: l.amountOut.toString() });
  return out;
}

async function unmatched(
  tx: Db,
  l: PaidLog,
  reason: UnmatchedReason,
  details: Record<string, unknown>,
  inv: InvoiceRow | null,
  now: Date,
): Promise<{ outcome: LogOutcome; enqueued: boolean }> {
  await tx.insert(unmatchedEvents).values({
    txHash: l.txHash,
    logIndex: l.logIndex,
    reason,
    payload: {
      invoiceId: l.invoiceId,
      payer: l.payer,
      merchant: l.merchant,
      tokenOut: l.tokenOut,
      amountOut: l.amountOut.toString(),
      blockNumber: l.blockNumber.toString(),
      blockTimestamp: l.blockTimestamp.toString(),
      ...details,
    },
  });
  let enqueued = false;
  if (inv && MERCHANT_RECEIVED.has(reason)) {
    const [m] = await tx.select({ language: merchants.language }).from(merchants).where(eq(merchants.id, inv.merchantId));
    enqueued = await enqueue(
      tx,
      alertKey(l.txHash, l.logIndex),
      { kind: "text", merchantId: inv.merchantId, message: alertText((m?.language ?? "es") as Language, reason, inv, l.txHash) },
      now,
    );
  }
  return { outcome: { kind: "unmatched", reason }, enqueued };
}

function alertText(lang: Language, reason: UnmatchedReason, inv: InvoiceRow, txHash: string): string {
  const ref = inv.reference ?? inv.id.slice(0, 10);
  const amount = `${inv.amountLocal} ${inv.currency}`;
  const url = explorerTx(txHash);
  const why: Record<Language, Partial<Record<UnmatchedReason, string>>> = {
    es: { already_paid: "ya estaba pagado (pago duplicado)", paid_while_expired: "estaba vencido", paid_while_cancelled: "estaba cancelado" },
    pt: { already_paid: "já estava pago (pagamento duplicado)", paid_while_expired: "estava vencido", paid_while_cancelled: "estava cancelado" },
    en: { already_paid: "was already paid (duplicate payment)", paid_while_expired: "had expired", paid_while_cancelled: "was cancelled" },
  };
  const w = why[lang]?.[reason] ?? why.en[reason];
  if (lang === "pt") return `Você recebeu ${amount} (ref ${ref}), mas o cobro ${w}. O dinheiro está na sua carteira. Tx: ${url}`;
  if (lang === "en") return `You received ${amount} (ref ${ref}), but the invoice ${w}. The money is in your wallet. Tx: ${url}`;
  return `Recibiste ${amount} (ref ${ref}), pero el cobro ${w}. El dinero está en tu billetera. Tx: ${url}`;
}
