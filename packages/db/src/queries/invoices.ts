/** Read queries on invoices (WS6). Shared by bot (/cobros), dashboard and API routes. */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { InvoiceStatus } from "@cobra/shared";
import type { Db } from "../client";
import { invoices } from "../schema";
import type { InvoiceRow } from "../repo";

export interface ListInvoicesOptions {
  /** One status or several; omitted = all statuses. */
  status?: InvoiceStatus | readonly InvoiceStatus[];
  /** Default 50, capped at 500. */
  limit?: number;
  /** Keyset pagination: only invoices created strictly before this instant. */
  before?: Date;
}

/** Newest first (createdAt desc, id desc). Uses invoices_merchant_status_idx. */
export async function listInvoicesByMerchant(db: Db, merchantId: string, opts: ListInvoicesOptions = {}): Promise<InvoiceRow[]> {
  const statuses = opts.status === undefined ? null : typeof opts.status === "string" ? [opts.status] : [...opts.status];
  if (statuses && statuses.length === 0) return [];
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 500);
  return db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.merchantId, merchantId),
        statuses ? inArray(invoices.status, statuses) : undefined,
        opts.before ? lt(invoices.createdAt, opts.before) : undefined,
      ),
    )
    .orderBy(desc(invoices.createdAt), desc(invoices.id))
    .limit(limit);
}

/** Count per status for one merchant (dashboard header). Missing statuses are 0. */
export async function countInvoicesByStatus(db: Db, merchantId: string): Promise<Record<InvoiceStatus, number>> {
  const out: Record<InvoiceStatus, number> = { open: 0, submitted: 0, paid: 0, expired: 0, cancelled: 0 };
  const rows = await db
    .select({ status: invoices.status, n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(eq(invoices.merchantId, merchantId))
    .groupBy(invoices.status);
  for (const r of rows) out[r.status] = r.n;
  return out;
}
