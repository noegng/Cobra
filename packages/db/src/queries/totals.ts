/**
 * Daily totals per merchant in a timezone (WS6). Used by the bot's daily close and the dashboard.
 * Only on-chain-confirmed money counts: rows come from `payments` (written by the indexer), and the
 * day is the merchant-local date of the block timestamp (`payments.paid_at`).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import { invoices, merchants, payments } from "../schema";

export interface DailyTotal {
  /** Merchant-local calendar day, "YYYY-MM-DD". */
  day: string;
  /** Invoice currency (local fiat or USD). */
  currency: string;
  tokenOut: string;
  count: number;
  /** Exact decimal sum of invoices.amount_local, as a string. */
  amountLocal: string;
  /** Exact sum of payments.amount_out in base units of tokenOut, as an integer string. */
  amountOut: string;
}

export interface DailyTotalsOptions {
  /** Inclusive local dates "YYYY-MM-DD". */
  from: string;
  to: string;
  /** IANA zone. Defaults to the merchant's `timezone`. */
  timezone?: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" of `at` in `timezone` (e.g. today's date for a merchant's daily close). */
export function localDay(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export async function merchantTimezone(db: Db, merchantId: string): Promise<string> {
  const [m] = await db.select({ tz: merchants.timezone }).from(merchants).where(eq(merchants.id, merchantId));
  if (!m) throw new Error(`unknown merchant ${merchantId}`);
  return m.tz;
}

/** One row per (day, currency, tokenOut) with at least one payment, ordered by day. */
export async function dailyTotalsByMerchant(db: Db, merchantId: string, opts: DailyTotalsOptions): Promise<DailyTotal[]> {
  if (!DAY_RE.test(opts.from) || !DAY_RE.test(opts.to)) throw new Error("from/to must be YYYY-MM-DD");
  const tz = opts.timezone ?? (await merchantTimezone(db, merchantId));
  const localDate = sql`(${payments.paidAt} at time zone ${tz})::date`;
  return db
    .select({
      day: sql<string>`to_char(${localDate}, 'YYYY-MM-DD')`,
      currency: invoices.currency,
      tokenOut: payments.tokenOut,
      count: sql<number>`count(*)::int`,
      amountLocal: sql<string>`sum(${invoices.amountLocal}::numeric)::text`,
      amountOut: sql<string>`sum(${payments.amountOut}::numeric)::text`,
    })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(and(eq(invoices.merchantId, merchantId), sql`${localDate} between ${opts.from}::date and ${opts.to}::date`))
    // Positional GROUP BY: the tz parameter appears twice, Postgres can't match parameterised expressions.
    .groupBy(sql`1, 2, 3`)
    .orderBy(asc(sql`1`), asc(sql`2`), asc(sql`3`));
}
