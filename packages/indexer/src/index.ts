/**
 * @cobra/indexer — WS6. Reads `Paid` logs, reconciles invoices, runs expiry (plan §9).
 * FROZEN public signatures below; internals are yours.
 */
import { and, eq, lt } from "drizzle-orm";
import { invoices, type Db } from "@cobra/db";
import { canTransition, type Notifier } from "@cobra/shared";
import type { Address, PublicClient } from "viem";
import { DEFAULT_CONFIRMATIONS, DEFAULT_MAX_BLOCK_RANGE, DEFAULT_POLL_INTERVAL_MS, runIndexer } from "./indexer";

export interface IndexerOptions {
  db: Db;
  publicClient: PublicClient;
  router: Address;
  /** Block the router was deployed at (first scan start). */
  fromBlock: bigint;
  /**
   * Legacy router still followed after a router switch (v1 once v2 is `router`). Same `Paid` event, same matching
   * rule; a single cursor starts at the earliest of the two deploy blocks on a fresh database.
   */
  legacyRouter?: { address: Address; fromBlock: bigint };
  confirmations?: number; // default 5 (~5 s on Celo L2, see DEFAULT_CONFIRMATIONS)
  maxBlockRange?: number; // default 2000
  pollIntervalMs?: number; // default 2000
  reorgWindow?: number; // blocks of recent payments re-verified (default 600, 0 = off)
  reorgCheckIntervalMs?: number; // default 10 000
  reorgMinSuspectGapMs?: number; // min spacing of consecutive "missing" observations (default 30 000)
  notifier?: Notifier;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Stoppable {
  stop(): Promise<void>;
}

/**
 * Starts the background loop and returns immediately. `stop()` lets the in-flight batch commit,
 * then resolves. Safe to restart: progress lives in `chain_cursor` ("router_paid" = next block to scan).
 */
export function startIndexer(opts: IndexerOptions): Stoppable {
  return runIndexer({
    db: opts.db,
    publicClient: opts.publicClient,
    router: opts.router,
    fromBlock: opts.fromBlock,
    ...(opts.legacyRouter && { legacyRouter: opts.legacyRouter }),
    confirmations: opts.confirmations ?? DEFAULT_CONFIRMATIONS,
    maxBlockRange: opts.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE,
    pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    ...(opts.reorgWindow !== undefined && { reorgWindow: opts.reorgWindow }),
    ...(opts.reorgCheckIntervalMs !== undefined && { reorgCheckIntervalMs: opts.reorgCheckIntervalMs }),
    ...(opts.reorgMinSuspectGapMs !== undefined && { reorgMinSuspectGapMs: opts.reorgMinSuspectGapMs }),
    notifier: opts.notifier,
    log: opts.log ?? (() => {}),
  });
}

/**
 * Mark open invoices past expiresAt as expired. Returns number of rows changed.
 * Only `open` ever expires: a `submitted` invoice has a tx in flight and is settled by the
 * indexer (paid) or the relayer (back to open, then expired on a later run).
 */
export async function expireInvoices(db: Db, now: Date): Promise<number> {
  if (!canTransition("open", "expired")) throw new Error("state machine forbids open -> expired");
  const rows = await db
    .update(invoices)
    .set({ status: "expired" })
    .where(and(eq(invoices.status, "open"), lt(invoices.expiresAt, now)))
    .returning({ id: invoices.id });
  return rows.length;
}

export { DEFAULT_CONFIRMATIONS, DEFAULT_MAX_BLOCK_RANGE, DEFAULT_POLL_INTERVAL_MS } from "./indexer";
export { CURSOR_ID, applyBatch, type PaidLog, type UnmatchedReason } from "./reconcile";
export { drainOutbox, listOutbox, OUTBOX_PREFIX, type OutboxValue } from "./outbox";
export { isRangeError } from "./rpc-errors";
