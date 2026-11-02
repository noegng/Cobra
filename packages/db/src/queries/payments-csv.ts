/** Payments export for accountants (WS6): rows + RFC 4180 CSV with spreadsheet-formula guard. */
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../client";
import { invoices, payments } from "../schema";
import { merchantTimezone } from "./totals";

export interface PaymentCsvRow {
  paidAt: string; // ISO-8601 UTC (block timestamp)
  localDate: string; // YYYY-MM-DD in the merchant timezone
  localTime: string; // HH:MM:SS in the merchant timezone
  invoiceId: string;
  reference: string | null;
  description: string | null;
  amountLocal: string;
  currency: string;
  tokenOut: string;
  amountOut: string; // base units
  payer: string;
  txHash: string;
  blockNumber: string;
}

export const PAYMENT_CSV_COLUMNS: readonly (keyof PaymentCsvRow)[] = [
  "paidAt", "localDate", "localTime", "invoiceId", "reference", "description", "amountLocal", "currency",
  "tokenOut", "amountOut", "payer", "txHash", "blockNumber",
];

export interface PaymentCsvOptions {
  /** Inclusive lower bound on paid_at. */
  from?: Date;
  /** Exclusive upper bound on paid_at. */
  to?: Date;
  /** IANA zone for localDate/localTime. Defaults to the merchant's `timezone`. */
  timezone?: string;
}

/** Oldest first. */
export async function paymentCsvRows(db: Db, merchantId: string, opts: PaymentCsvOptions = {}): Promise<PaymentCsvRow[]> {
  const tz = opts.timezone ?? (await merchantTimezone(db, merchantId));
  const local = sql`(${payments.paidAt} at time zone ${tz})`;
  const rows = await db
    .select({
      paidAt: payments.paidAt,
      localDate: sql<string>`to_char(${local}, 'YYYY-MM-DD')`,
      localTime: sql<string>`to_char(${local}, 'HH24:MI:SS')`,
      invoiceId: invoices.id,
      reference: invoices.reference,
      description: invoices.description,
      amountLocal: invoices.amountLocal,
      currency: invoices.currency,
      tokenOut: payments.tokenOut,
      amountOut: payments.amountOut,
      payer: payments.payer,
      txHash: payments.txHash,
      blockNumber: payments.blockNumber,
    })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(
      and(
        eq(invoices.merchantId, merchantId),
        opts.from ? gte(payments.paidAt, opts.from) : undefined,
        opts.to ? lt(payments.paidAt, opts.to) : undefined,
      ),
    )
    .orderBy(asc(payments.paidAt), asc(payments.blockNumber), asc(payments.logIndex));
  return rows.map((r) => ({ ...r, paidAt: r.paidAt.toISOString(), blockNumber: r.blockNumber.toString() }));
}

function cell(v: string | null): string {
  let s = v ?? "";
  // CSV/formula injection: a description like "=HYPERLINK(...)" must not execute in Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: readonly PaymentCsvRow[], columns: readonly (keyof PaymentCsvRow)[] = PAYMENT_CSV_COLUMNS): string {
  const lines = [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))];
  return lines.join("\r\n") + "\r\n";
}
