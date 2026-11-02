/**
 * Durable notification outbox, stored in the `flags` table (no schema change needed).
 *
 * - Entries are inserted in the SAME transaction as the payment / unmatched row, so a crash between
 *   commit and notify cannot lose a notification, and re-processing a block range cannot create a
 *   second entry (keys are deterministic, inserts are ON CONFLICT DO NOTHING; and the reconciler
 *   only enqueues when it actually inserted a new payment / unmatched row).
 * - The indexer drains it after each committed batch and on every tick. Success deletes the entry;
 *   failure bumps `attempts` and schedules a retry with exponential backoff. The cursor never waits
 *   for the notifier.
 * - Delivery is at-least-once: a crash after the notifier returned but before the delete would resend.
 *
 * Keys: `outbox:invoice_paid:<invoiceId>` and `outbox:alert:<txHash>:<logIndex>`.
 */
import { asc, eq, like } from "drizzle-orm";
import { flags, type Db } from "@cobra/db";
import type { Notifier } from "@cobra/shared";

export const OUTBOX_PREFIX = "outbox:";
export const OUTBOX_MAX_ATTEMPTS = 20;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60 * 60_000;

export type InvoicePaidArgs = Parameters<Notifier["invoicePaid"]>[0];

export type OutboxMessage =
  | { kind: "invoicePaid"; args: InvoicePaidArgs }
  | { kind: "text"; merchantId: string; message: string };

export interface OutboxValue {
  msg: OutboxMessage;
  attempts: number;
  nextAttemptAt: string; // ISO
  createdAt: string; // ISO
  lastError?: string;
  dead?: boolean; // gave up after OUTBOX_MAX_ATTEMPTS
}

export const invoicePaidKey = (invoiceId: string) => `${OUTBOX_PREFIX}invoice_paid:${invoiceId.toLowerCase()}`;
export const alertKey = (txHash: string, logIndex: number) => `${OUTBOX_PREFIX}alert:${txHash.toLowerCase()}:${logIndex}`;

/** Enqueue inside the caller's transaction. Returns true if a new entry was created. */
export async function enqueue(tx: Db, key: string, msg: OutboxMessage, now: Date): Promise<boolean> {
  const value: OutboxValue = { msg, attempts: 0, nextAttemptAt: now.toISOString(), createdAt: now.toISOString() };
  const rows = await tx.insert(flags).values({ key, value }).onConflictDoNothing().returning({ key: flags.key });
  return rows.length > 0;
}

export async function listOutbox(db: Db): Promise<{ key: string; value: OutboxValue }[]> {
  const rows = await db.select().from(flags).where(like(flags.key, `${OUTBOX_PREFIX}%`)).orderBy(asc(flags.updatedAt));
  return rows.map((r) => ({ key: r.key, value: r.value as OutboxValue }));
}

function retryDelayMs(attempts: number): number {
  return Math.min(BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
}

export interface DrainResult {
  sent: number;
  failed: number;
}

/** Send every due entry once. Never throws because of the notifier (DB errors do propagate). */
export async function drainOutbox(
  db: Db,
  notifier: Notifier,
  now: Date,
  log: (msg: string, extra?: Record<string, unknown>) => void,
): Promise<DrainResult> {
  const res: DrainResult = { sent: 0, failed: 0 };
  for (const { key, value } of await listOutbox(db)) {
    if (value.dead || new Date(value.nextAttemptAt) > now) continue;
    try {
      if (value.msg.kind === "invoicePaid") await notifier.invoicePaid(value.msg.args);
      else await notifier.text(value.msg.merchantId, value.msg.message);
    } catch (e) {
      res.failed++;
      const attempts = value.attempts + 1;
      const dead = attempts >= OUTBOX_MAX_ATTEMPTS;
      const next: OutboxValue = {
        ...value,
        attempts,
        lastError: String(e instanceof Error ? e.message : e).slice(0, 500),
        nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)).toISOString(),
        ...(dead ? { dead: true } : {}),
      };
      await db.update(flags).set({ value: next, updatedAt: now }).where(eq(flags.key, key));
      log(dead ? "indexer_notify_dead" : "indexer_notify_failed", { level: dead ? "alert" : "warn", key, attempts, error: next.lastError });
      continue;
    }
    await db.delete(flags).where(eq(flags.key, key));
    res.sent++;
  }
  return res;
}
