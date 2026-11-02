/** Merchant dashboard (read-only), built on WS6's shared queries in @cobra/db/queries. */
import { eq, inArray } from "drizzle-orm";
import { fromBaseUnits, toBaseUnits } from "@cobra/shared";
import { merchants, payments, type Db } from "@cobra/db";
import {
  countInvoicesByStatus,
  dailyTotalsByMerchant,
  listInvoicesByMerchant,
  localDay,
  paymentCsvRows,
  toCsv,
} from "@cobra/db/queries";
import { effectiveStatus } from "./invoices";

export const DASHBOARD_MAX_ROWS = 500;

export interface DashboardRow {
  id: string;
  createdAt: Date;
  reference: string | null;
  description: string | null;
  amountLocal: string;
  currency: string;
  status: string;
  txHash: string | null;
}

export interface DashboardData {
  merchant: { id: string; displayName: string | null; currency: string; payoutAddress: string; language: string; timezone: string };
  rows: DashboardRow[];
  /** Only on-chain-confirmed money (payments rows) counts, in the merchant's currency and timezone. */
  totals: { currency: string; paidCount: number; paidTotal: string; openCount: number; todayPaidTotal: string; todayPaidCount: number };
}

const SUM_DECIMALS = 18;
const EPOCH_DAY = "2026-01-01";

function sumLocal(rows: { currency: string; count: number; amountLocal: string }[], currency: string) {
  let total = 0n;
  let count = 0;
  for (const r of rows) {
    if (r.currency !== currency) continue;
    total += toBaseUnits(r.amountLocal, SUM_DECIMALS);
    count += r.count;
  }
  return { total: fromBaseUnits(total, SUM_DECIMALS), count };
}

export async function loadDashboard(db: Db, merchantId: string, now: number): Promise<DashboardData | null> {
  const [m] = await db.select().from(merchants).where(eq(merchants.id, merchantId));
  if (!m) return null;
  const today = localDay(new Date(now), m.timezone);
  const [list, todayRows, allRows, counts] = await Promise.all([
    listInvoicesByMerchant(db, merchantId, { limit: DASHBOARD_MAX_ROWS }),
    dailyTotalsByMerchant(db, merchantId, { from: today, to: today, timezone: m.timezone }),
    dailyTotalsByMerchant(db, merchantId, { from: EPOCH_DAY, to: today, timezone: m.timezone }),
    countInvoicesByStatus(db, merchantId),
  ]);
  const ids = list.map((i) => i.id);
  const pays = ids.length
    ? await db.select({ invoiceId: payments.invoiceId, txHash: payments.txHash }).from(payments).where(inArray(payments.invoiceId, ids))
    : [];
  const txByInvoice = new Map(pays.map((p) => [p.invoiceId, p.txHash]));
  const t = sumLocal(todayRows, m.currency);
  const a = sumLocal(allRows, m.currency);
  return {
    merchant: {
      id: m.id,
      displayName: m.displayName,
      currency: m.currency,
      payoutAddress: m.payoutAddress,
      language: m.language,
      timezone: m.timezone,
    },
    rows: list.map((i) => ({
      id: i.id,
      createdAt: i.createdAt,
      reference: i.reference,
      description: i.description,
      amountLocal: i.amountLocal,
      currency: i.currency,
      status: effectiveStatus(i, now),
      txHash: txByInvoice.get(i.id) ?? null,
    })),
    totals: {
      currency: m.currency,
      paidCount: a.count,
      paidTotal: a.total,
      openCount: counts.open + counts.submitted,
      todayPaidCount: t.count,
      todayPaidTotal: t.total,
    },
  };
}

/** Accountant export: confirmed payments (WS6 `paymentCsvRows` + formula-safe `toCsv`). */
export async function dashboardCsv(db: Db, merchantId: string): Promise<string> {
  return toCsv(await paymentCsvRows(db, merchantId));
}
