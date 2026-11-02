/**
 * @cobra/indexer — WS6. Reads `Paid` logs, reconciles invoices, runs expiry (plan §9).
 * FROZEN public signatures below; internals are yours.
 */
import type { Db } from "@cobra/db";
import type { Notifier } from "@cobra/shared";
import type { Address, PublicClient } from "viem";

export interface IndexerOptions {
  db: Db;
  publicClient: PublicClient;
  router: Address;
  /** Block the router was deployed at (first scan start). */
  fromBlock: bigint;
  confirmations?: number; // default 2
  maxBlockRange?: number; // default 2000
  pollIntervalMs?: number;
  notifier?: Notifier;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Stoppable {
  stop(): Promise<void>;
}

export function startIndexer(_opts: IndexerOptions): Stoppable {
  throw new Error("not implemented (WS6)");
}

/** Mark open invoices past expiresAt as expired. Returns number of rows changed. */
export async function expireInvoices(_db: Db, _now: Date): Promise<number> {
  throw new Error("not implemented (WS6)");
}
