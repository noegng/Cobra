/**
 * Public proof-of-activity aggregates (E2). Everything derives from `payments` rows written by the
 * indexer (each has a tx_hash), joined to `invoices` only to count merchants.
 */
import { desc, sql } from "drizzle-orm";
import type { Db } from "../client";
import { invoices, payments } from "../schema";

export interface ProofPayment {
  txHash: string;
  logIndex: number;
  payer: string;
  tokenOut: string;
  amountOut: string;
  savingsBps: number | null;
  paidAt: Date;
}

export interface ProofVolume {
  tokenOut: string;
  count: number;
  /** Exact sum of amount_out in base units, integer string. */
  amountOut: string;
}

export interface ProofStats {
  paymentCount: number;
  distinctPayers: number;
  merchantCount: number;
  /** Mean savings_bps over payments where it is known (rounded to integer); null if none. */
  avgSavingsBps: number | null;
  volumeByToken: ProofVolume[];
  /** Latest payments, newest first. */
  recent: ProofPayment[];
}

export async function proofStats(db: Db, recentLimit = 50): Promise<ProofStats> {
  const [agg] = await db
    .select({
      paymentCount: sql<number>`count(*)::int`,
      distinctPayers: sql<number>`count(distinct lower(${payments.payer}))::int`,
      merchantCount: sql<number>`count(distinct ${invoices.merchantId})::int`,
      avgSavingsBps: sql<string | null>`round(avg(${payments.savingsBps}))::text`,
    })
    .from(payments)
    .innerJoin(invoices, sql`${invoices.id} = ${payments.invoiceId}`);
  const volumeByToken = await db
    .select({
      tokenOut: payments.tokenOut,
      count: sql<number>`count(*)::int`,
      amountOut: sql<string>`sum(${payments.amountOut}::numeric)::text`,
    })
    .from(payments)
    .groupBy(payments.tokenOut)
    .orderBy(payments.tokenOut);
  const recent = await db
    .select({
      txHash: payments.txHash,
      logIndex: payments.logIndex,
      payer: payments.payer,
      tokenOut: payments.tokenOut,
      amountOut: payments.amountOut,
      savingsBps: payments.savingsBps,
      paidAt: payments.paidAt,
    })
    .from(payments)
    .orderBy(desc(payments.paidAt), desc(payments.blockNumber))
    .limit(recentLimit);
  return {
    paymentCount: agg?.paymentCount ?? 0,
    distinctPayers: agg?.distinctPayers ?? 0,
    merchantCount: agg?.merchantCount ?? 0,
    avgSavingsBps: agg?.avgSavingsBps == null ? null : Number(agg.avgSavingsBps),
    volumeByToken,
    recent,
  };
}
