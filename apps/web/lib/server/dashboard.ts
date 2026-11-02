/** Merchant dashboard queries + CSV (read-only). */
import { desc, eq } from "drizzle-orm";
import { fromBaseUnits, toBaseUnits } from "@cobra/shared";
import { invoices, merchants, payments, type Db } from "@cobra/db";
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
  source: string;
  paidAt: Date | null;
  txHash: string | null;
  payer: string | null;
}

export interface DashboardData {
  merchant: { id: string; displayName: string | null; currency: string; payoutAddress: string; language: string; timezone: string };
  rows: DashboardRow[];
  totals: { currency: string; paidCount: number; paidTotal: string; openCount: number; todayPaidTotal: string; todayPaidCount: number };
}

const SUM_DECIMALS = 18;

export async function loadDashboard(db: Db, merchantId: string, now: number): Promise<DashboardData | null> {
  const [m] = await db.select().from(merchants).where(eq(merchants.id, merchantId));
  if (!m) return null;
  const list = await db
    .select({ invoice: invoices, payment: payments })
    .from(invoices)
    .leftJoin(payments, eq(payments.invoiceId, invoices.id))
    .where(eq(invoices.merchantId, merchantId))
    .orderBy(desc(invoices.createdAt))
    .limit(DASHBOARD_MAX_ROWS);

  const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: m.timezone });
  const today = dayKey(new Date(now));
  let paidTotal = 0n;
  let todayTotal = 0n;
  let paidCount = 0;
  let todayCount = 0;
  let openCount = 0;
  const rows: DashboardRow[] = list.map(({ invoice, payment }) => {
    const status = effectiveStatus(invoice, now);
    if (status === "paid" && invoice.currency === m.currency) {
      const v = toBaseUnits(invoice.amountLocal, SUM_DECIMALS);
      paidTotal += v;
      paidCount++;
      const paidAt = invoice.paidAt ?? payment?.paidAt ?? invoice.createdAt;
      if (dayKey(paidAt) === today) {
        todayTotal += v;
        todayCount++;
      }
    }
    if (status === "open" || status === "submitted") openCount++;
    return {
      id: invoice.id,
      createdAt: invoice.createdAt,
      reference: invoice.reference,
      description: invoice.description,
      amountLocal: invoice.amountLocal,
      currency: invoice.currency,
      status,
      source: invoice.source,
      paidAt: invoice.paidAt ?? payment?.paidAt ?? null,
      txHash: payment?.txHash ?? null,
      payer: payment?.payer ?? null,
    };
  });
  return {
    merchant: {
      id: m.id,
      displayName: m.displayName,
      currency: m.currency,
      payoutAddress: m.payoutAddress,
      language: m.language,
      timezone: m.timezone,
    },
    rows,
    totals: {
      currency: m.currency,
      paidCount,
      paidTotal: fromBaseUnits(paidTotal, SUM_DECIMALS),
      openCount,
      todayPaidCount: todayCount,
      todayPaidTotal: fromBaseUnits(todayTotal, SUM_DECIMALS),
    },
  };
}

/** RFC 4180 field; also neutralises spreadsheet formula injection (=,+,-,@ prefixes). */
export function csvField(v: string | null | undefined): string {
  let s = v ?? "";
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function dashboardCsv(data: DashboardData): string {
  const header = ["invoice_id", "created_at", "reference", "description", "amount_local", "currency", "status", "source", "paid_at", "tx_hash", "payer"];
  const lines = [header.join(",")];
  for (const r of data.rows) {
    lines.push(
      [
        r.id,
        r.createdAt.toISOString(),
        r.reference,
        r.description,
        r.amountLocal,
        r.currency,
        r.status,
        r.source,
        r.paidAt ? r.paidAt.toISOString() : "",
        r.txHash,
        r.payer,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
