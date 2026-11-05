/**
 * Merchant-scoped invoice operations. Every function takes the merchant id from the caller (resolved from the
 * Telegram user id), never from user / model input, and every query filters on it.
 */
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getAddress } from "viem";
import { invoices, payments, transitionInvoice, type Db, type InvoiceRow } from "@cobra/db";
import {
  INVOICE_TTL_SECONDS,
  explorerTx,
  fromBaseUnits,
  randomInvoiceId,
  toBaseUnits,
  tokenByAddress,
  type InvoiceStatus,
} from "@cobra/shared";
import { sumDecimals } from "./amount";
import type { MerchantRow } from "./merchants";
import { nextCounter, stateKeys } from "./state";
import { localDateTime, localDayRange } from "./time";
import { chargeSize, type ChargeSize } from "./limits";
import { isUsdtAddress, quoteUsdt, type RateSource } from "./usd";

export const INVOICE_RATE_LIMIT = { max: 10, windowMs: 60_000 } as const;
export const DESCRIPTION_MAX = 100;

export type CreateInvoiceError = "rate_limited" | "unsupported_settlement" | "rate_unavailable" | "over_limit" | "needs_confirmation";
/** `size` is the dollar check (limits.ts): set on over_limit / needs_confirmation, and on success when a rate was known. */
export type CreateInvoiceResult =
  | { ok: true; invoice: InvoiceRow; size: ChargeSize }
  | { ok: false; error: CreateInvoiceError; size?: ChargeSize };

export function formatReference(n: number): string {
  return `A-${String(n).padStart(4, "0")}`;
}

/** Strips control characters and caps length. Plain text only. */
export function cleanDescription(d: string | null | undefined): string | null {
  if (!d) return null;
  const s = d.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, DESCRIPTION_MAX) : null;
}

/**
 * Creates an invoice for an already-parsed local amount (decimal string, see amount.ts). The invoice currency is
 * always the merchant's local currency. Settlement:
 *  - wFIAT of that currency, 1:1: amountOut = amountLocal in token base units;
 *  - USD₮: amountOut = ceil(amountLocal × 10^6 / localPerUsd) at the reference rate read now (usd.ts);
 *    no rate -> `rate_unavailable`, nothing is created.
 * Size (limits.ts): above the per-payment cap -> `over_limit`; from half the cap -> `needs_confirmation` unless
 * `confirmed` (the merchant pressed "yes"). Without a rate the size is unknown and does not block.
 */
export async function createInvoice(
  db: Db,
  merchant: MerchantRow,
  args: { amountLocal: string; description?: string | null; now: Date; source?: "chat" | "dashboard"; rates?: RateSource; confirmed?: boolean },
): Promise<CreateInvoiceResult> {
  const token = tokenByAddress(merchant.settlementToken);
  const usdt = isUsdtAddress(merchant.settlementToken);
  if (!token || (!usdt && (token.kind !== "wfiat" || token.currency !== merchant.currency))) {
    return { ok: false, error: "unsupported_settlement" };
  }

  const since = new Date(args.now.getTime() - INVOICE_RATE_LIMIT.windowMs);
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(eq(invoices.merchantId, merchant.id), gte(invoices.createdAt, since)));
  if ((recent?.n ?? 0) >= INVOICE_RATE_LIMIT.max) return { ok: false, error: "rate_limited" };

  const size = await chargeSize(db, args.amountLocal, merchant.currency, args.rates);
  if (size.kind === "over") return { ok: false, error: "over_limit", size };
  if (size.kind === "confirm" && !args.confirmed) return { ok: false, error: "needs_confirmation", size };

  let amountOut: bigint;
  if (usdt) {
    const q = await quoteUsdt(args.amountLocal, merchant.currency, args.rates);
    if (!q.ok) return { ok: false, error: q.error };
    amountOut = q.amountOut;
  } else {
    amountOut = toBaseUnits(args.amountLocal, token.decimals);
  }
  const reference = formatReference(await nextCounter(db, stateKeys.refSeq(merchant.id)));
  const [row] = await db
    .insert(invoices)
    .values({
      id: randomInvoiceId(),
      merchantId: merchant.id,
      amountLocal: args.amountLocal,
      currency: merchant.currency,
      tokenOut: getAddress(token.address),
      amountOut: amountOut.toString(),
      merchantAddress: getAddress(merchant.payoutAddress),
      reference,
      description: cleanDescription(args.description),
      status: "open",
      source: args.source ?? "chat",
      expiresAt: new Date(args.now.getTime() + INVOICE_TTL_SECONDS * 1000),
      createdAt: args.now,
    })
    .returning();
  return { ok: true, invoice: row!, size };
}

/** Accepts "A-0042", "a-42", "#42", "42" or a full 0x invoice id. */
export function normalizeInvoiceRef(input: string): { id: string } | { reference: string } | null {
  const s = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return { id: s.toLowerCase() };
  const m = /^(?:#|a-?\s*)?0*(\d{1,9})$/i.exec(s);
  if (!m) return null;
  return { reference: formatReference(Number(m[1])) };
}

export async function findInvoice(db: Db, merchantId: string, ref: string): Promise<InvoiceRow | null> {
  const n = normalizeInvoiceRef(ref);
  if (!n) return null;
  const cond = "id" in n ? eq(invoices.id, n.id) : eq(invoices.reference, n.reference);
  const [row] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.merchantId, merchantId), cond))
    .orderBy(desc(invoices.createdAt), desc(invoices.reference))
    .limit(1);
  return row ?? null;
}

export async function latestInvoice(db: Db, merchantId: string): Promise<InvoiceRow | null> {
  const [row] = await db.select().from(invoices).where(eq(invoices.merchantId, merchantId)).orderBy(desc(invoices.createdAt), desc(invoices.reference)).limit(1);
  return row ?? null;
}

export async function listInvoices(
  db: Db,
  merchantId: string,
  opts: { status?: InvoiceStatus; limit?: number } = {},
): Promise<InvoiceRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const where = opts.status
    ? and(eq(invoices.merchantId, merchantId), eq(invoices.status, opts.status))
    : eq(invoices.merchantId, merchantId);
  return db.select().from(invoices).where(where).orderBy(desc(invoices.createdAt), desc(invoices.reference)).limit(limit);
}

export interface InvoiceStatusInfo {
  invoice: InvoiceRow;
  txHash: string | null;
  explorerUrl: string | null;
}

export async function invoiceStatus(db: Db, merchantId: string, ref: string): Promise<InvoiceStatusInfo | null> {
  const inv = await findInvoice(db, merchantId, ref);
  if (!inv) return null;
  const [p] = await db.select({ txHash: payments.txHash }).from(payments).where(eq(payments.invoiceId, inv.id));
  return { invoice: inv, txHash: p?.txHash ?? null, explorerUrl: p ? explorerTx(p.txHash) : null };
}

export type CancelResult =
  | { ok: true; invoice: InvoiceRow }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "not_open"; invoice: InvoiceRow };

/** Cancels an OPEN invoice only (atomic, via the shared state machine). */
export async function cancelInvoice(db: Db, merchantId: string, ref: string): Promise<CancelResult> {
  const inv = await findInvoice(db, merchantId, ref);
  if (!inv) return { ok: false, error: "not_found" };
  if (inv.status !== "open") return { ok: false, error: "not_open", invoice: inv };
  const updated = await transitionInvoice(db, inv.id, ["open"], "cancelled");
  if (!updated) {
    const [fresh] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    return { ok: false, error: "not_open", invoice: fresh ?? inv };
  }
  return { ok: true, invoice: updated };
}

export interface DailySummary {
  date: string;
  timezone: string;
  currency: string;
  created: number;
  paidCount: number;
  paidTotal: string;
  open: number;
  expired: number;
  cancelled: number;
  rows: Array<InvoiceRow & { txHash: string | null }>;
  csv: string;
}

const CSV_HEADER = ["reference", "invoice_id", "created_at", "status", "amount", "currency", "description", "paid_at", "tx_hash", "amount_out", "token_out"];

/** What the merchant receives, in token units (exact decimal string; no wFIAT 1:1 assumption). */
function outAmount(amountOut: string, tokenOut: string): string {
  const t = tokenByAddress(tokenOut);
  return t ? fromBaseUnits(BigInt(amountOut), t.decimals) : amountOut;
}

/** RFC 4180 quoting + spreadsheet formula-injection guard for merchant-provided text. */
export function csvCell(v: string | null | undefined): string {
  let s = v ?? "";
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Summary for local day `date` (YYYY-MM-DD) in the merchant's timezone: invoices created OR paid that day. */
export async function dailySummary(db: Db, merchant: MerchantRow, date: string): Promise<DailySummary> {
  const { start, end } = localDayRange(date, merchant.timezone);
  const rows = await db
    .select({ inv: invoices, txHash: payments.txHash })
    .from(invoices)
    .leftJoin(payments, eq(payments.invoiceId, invoices.id))
    .where(
      and(
        eq(invoices.merchantId, merchant.id),
        or(
          and(gte(invoices.createdAt, start), lt(invoices.createdAt, end)),
          and(gte(invoices.paidAt, start), lt(invoices.paidAt, end)),
        ),
      ),
    )
    .orderBy(invoices.createdAt);

  const flat = rows.map((r) => ({ ...r.inv, txHash: r.txHash ?? null }));
  const inDay = (d: Date | null) => !!d && d >= start && d < end;
  const createdToday = flat.filter((r) => inDay(r.createdAt));
  const paid = flat.filter((r) => r.status === "paid" && inDay(r.paidAt));
  const count = (s: InvoiceStatus) => createdToday.filter((r) => r.status === s).length;

  const tz = merchant.timezone;
  const lines = [CSV_HEADER.join(",")];
  for (const r of flat) {
    lines.push(
      [
        r.reference,
        r.id,
        localDateTime(r.createdAt, tz),
        r.status,
        r.amountLocal,
        r.currency,
        r.description,
        r.paidAt ? localDateTime(r.paidAt, tz) : "",
        r.txHash,
        outAmount(r.amountOut, r.tokenOut),
        tokenByAddress(r.tokenOut)?.symbol ?? r.tokenOut,
      ]
        .map(csvCell)
        .join(","),
    );
  }

  return {
    date,
    timezone: tz,
    currency: merchant.currency,
    created: createdToday.length,
    paidCount: paid.length,
    paidTotal: sumDecimals(paid.map((r) => r.amountLocal)),
    open: count("open") + count("submitted"),
    expired: count("expired"),
    cancelled: count("cancelled"),
    rows: flat,
    csv: `${lines.join("\r\n")}\r\n`,
  };
}

export const REMINDER_LEAD_MS = 3 * 60_000;

/** Open chat/dashboard invoices expiring within the lead window that were never reminded. */
export async function dueReminders(db: Db, now: Date, leadMs = REMINDER_LEAD_MS): Promise<InvoiceRow[]> {
  return db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.status, "open"),
        isNull(invoices.lastReminderAt),
        inArray(invoices.source, ["chat", "dashboard"]),
        gte(invoices.expiresAt, now),
        lt(invoices.expiresAt, new Date(now.getTime() + leadMs)),
      ),
    );
}

/** Atomically marks the reminder as sent; false if someone else already did. */
export async function markReminded(db: Db, invoiceId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(invoices)
    .set({ lastReminderAt: now })
    .where(and(eq(invoices.id, invoiceId), isNull(invoices.lastReminderAt), eq(invoices.status, "open")))
    .returning({ id: invoices.id });
  return rows.length === 1;
}

/**
 * OPEN, unexpired invoices that no longer match the merchant's current payout address, settlement token or
 * currency (after a wallet / currency / country change): paying them would still go to the previous one.
 */
export async function staleOpenInvoices(db: Db, merchant: MerchantRow, now: Date): Promise<InvoiceRow[]> {
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.merchantId, merchant.id), eq(invoices.status, "open"), gte(invoices.expiresAt, now)));
  const addr = merchant.payoutAddress.toLowerCase();
  const tok = merchant.settlementToken.toLowerCase();
  return rows.filter(
    (r) => r.merchantAddress.toLowerCase() !== addr || r.tokenOut.toLowerCase() !== tok || r.currency !== merchant.currency,
  );
}
