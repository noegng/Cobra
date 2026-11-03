/**
 * The `Paid` log loop.
 *
 * Cursor (`chain_cursor.router_paid`) = the NEXT block to scan. Each iteration:
 *   head = latest; safe = head - confirmations; scan [cursor, min(safe, cursor + range - 1)];
 *   fetch block timestamps; one DB transaction applies every log and sets cursor = to + 1;
 *   then drain the notification outbox. Notifier failures never block the cursor.
 *
 * Range: starts at maxBlockRange, halves on "range too large"/timeout errors (down to 1),
 * doubles back after 10 consecutive successful batches. Other errors: exponential backoff (1s..60s).
 */
import { getAbiItem, type Address, type PublicClient } from "viem";
import type { Db } from "@cobra/db";
import { cobraRouterAbi, type Notifier } from "@cobra/shared";
import { drainOutbox } from "./outbox";
import { applyBatch, loadCursor, type PaidLog } from "./reconcile";
import { verifyRecentPayments } from "./reorg";
import { errorMessage, isRangeError } from "./rpc-errors";

/**
 * Celo is an OP-stack L2 with ~1 s blocks: 5 confirmations ≈ 5 s of extra latency for the merchant,
 * enough to ride out sequencer-level reorgs of the unsafe head. See docs/reports/WS6-2026-11-02.md.
 */
export const DEFAULT_CONFIRMATIONS = 5;
export const DEFAULT_MAX_BLOCK_RANGE = 2000;
export const DEFAULT_POLL_INTERVAL_MS = 2000;
/** WS7-4: payments younger than this many blocks (~10 min on Celo L2) are re-verified against the chain. 0 disables. */
export const DEFAULT_REORG_WINDOW = 600;
export const DEFAULT_REORG_CHECK_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
const GROW_AFTER_SUCCESSES = 10;

export const paidEvent = getAbiItem({ abi: cobraRouterAbi, name: "Paid" });

export interface LoopOptions {
  db: Db;
  publicClient: PublicClient;
  router: Address;
  fromBlock: bigint;
  confirmations: number;
  maxBlockRange: number;
  pollIntervalMs: number;
  reorgWindow?: number;
  reorgCheckIntervalMs?: number;
  notifier?: Notifier;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export function runIndexer(o: LoopOptions): { stop(): Promise<void> } {
  if (!Number.isInteger(o.confirmations) || o.confirmations < 0) throw new Error("confirmations must be an integer >= 0");
  if (!Number.isInteger(o.maxBlockRange) || o.maxBlockRange < 1) throw new Error("maxBlockRange must be an integer >= 1");

  let stopped = false;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve();
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });

  const reorgWindow = o.reorgWindow ?? DEFAULT_REORG_WINDOW;
  const reorgEveryMs = o.reorgCheckIntervalMs ?? DEFAULT_REORG_CHECK_INTERVAL_MS;
  let lastReorgCheck = 0;

  const drain = async () => {
    if (!o.notifier) return;
    try {
      await drainOutbox(o.db, o.notifier, new Date(), o.log);
    } catch (e) {
      o.log("indexer_outbox_error", { level: "warn", error: errorMessage(e) });
    }
  };

  async function loop(): Promise<void> {
    let range = o.maxBlockRange;
    let successes = 0;
    let backoff = 0;
    let cursor: bigint | null = null;

    while (!stopped) {
      try {
        cursor ??= await loadCursor(o.db, o.fromBlock);
        await drain();

        const head = await o.publicClient.getBlockNumber({ cacheTime: 0 });
        if (reorgWindow > 0 && Date.now() - lastReorgCheck >= reorgEveryMs) {
          lastReorgCheck = Date.now();
          const r = await verifyRecentPayments({ db: o.db, publicClient: o.publicClient, router: o.router, head, window: reorgWindow, log: o.log });
          if (r.reverted > 0) {
            cursor = null; // the cursor was rewound in the DB: re-read it and re-scan
            await drain();
            continue;
          }
        }
        const safe = head - BigInt(o.confirmations);
        if (cursor > safe) {
          await sleep(o.pollIntervalMs);
          continue;
        }
        const from: bigint = cursor;
        const to: bigint = from + BigInt(range) - 1n < safe ? from + BigInt(range) - 1n : safe;

        let raw;
        try {
          raw = await o.publicClient.getLogs({ address: o.router, event: paidEvent, fromBlock: from, toBlock: to, strict: true });
        } catch (e) {
          if (isRangeError(e) && range > 1) {
            range = Math.max(1, Math.floor(range / 2));
            successes = 0;
            o.log("indexer_range_shrunk", { range, from: from.toString(), to: to.toString(), error: errorMessage(e) });
            continue;
          }
          throw e;
        }

        const confirmed = raw.filter((r) => !r.removed);
        const timestamps = new Map<bigint, bigint>();
        const logs: PaidLog[] = [];
        for (const r of confirmed) {
          if (r.blockNumber === null || r.transactionHash === null || r.logIndex === null) {
            throw new Error(`pending log returned for confirmed range ${from}-${to}`);
          }
          let ts = timestamps.get(r.blockNumber);
          if (ts === undefined) {
            ts = (await o.publicClient.getBlock({ blockNumber: r.blockNumber })).timestamp;
            timestamps.set(r.blockNumber, ts);
          }
          logs.push({
            invoiceId: r.args.invoiceId,
            payer: r.args.payer,
            merchant: r.args.merchant,
            tokenOut: r.args.tokenOut,
            amountOut: r.args.amountOut,
            txHash: r.transactionHash,
            logIndex: r.logIndex,
            blockNumber: r.blockNumber,
            blockTimestamp: ts,
          });
        }

        const res = await applyBatch(o.db, logs, from, to, o.log);
        cursor = to + 1n;
        backoff = 0;
        if (++successes >= GROW_AFTER_SUCCESSES && range < o.maxBlockRange) {
          range = Math.min(o.maxBlockRange, range * 2);
          successes = 0;
        }
        if (logs.length > 0) o.log("indexer_batch", { from: from.toString(), to: to.toString(), logs: logs.length, outcomes: res.outcomes.map((x) => x.kind) });
        if (res.enqueued > 0) await drain();
        if (to >= safe) await sleep(o.pollIntervalMs);
      } catch (e) {
        cursor = null; // re-read from DB: the failed transaction did not move it (or someone else did)
        backoff = Math.min(Math.max(backoff * 2, 1000), MAX_BACKOFF_MS);
        o.log("indexer_error", { level: "error", error: errorMessage(e), retryInMs: backoff });
        await sleep(backoff);
      }
    }
  }

  const done = loop();
  return {
    async stop() {
      stopped = true;
      wake?.();
      await done;
    },
  };
}
