/**
 * Small persistent state on top of the `flags` table, so the bot works on stateless serverless webhooks
 * (Vercel): onboarding progress, pending payout-address confirmations, reference counters, daily-close markers.
 */
import { and, eq, like, lt, sql } from "drizzle-orm";
import { flags, getFlag, setFlag, type Db } from "@cobra/db";
import type { CountryCode, Language } from "@cobra/shared";

export const stateKeys = {
  onboarding: (telegramUserId: bigint | number) => `bot:onboarding:${telegramUserId}`,
  pendingPayout: (merchantId: string) => `bot:pending_payout:${merchantId}`,
  refSeq: (merchantId: string) => `bot:ref_seq:${merchantId}`,
  dailyClose: (merchantId: string, date: string) => `daily_close:${merchantId}:${date}`,
  /** `/billetera` alone: the next text message is the new payout address. */
  awaitingWallet: (merchantId: string) => `bot:awaiting_wallet:${merchantId}`,
};

export interface AwaitingWallet {
  expiresAt: number; // unix ms
}

export interface OnboardingState {
  step: "country" | "address";
  language: Language;
  country?: CountryCode;
}

export interface PendingPayout {
  address: string;
  nonce: string;
  expiresAt: number; // unix ms
}

export async function readState<T>(db: Db, key: string): Promise<T | null> {
  return getFlag<T | null>(db, key, null);
}

export async function writeState(db: Db, key: string, value: unknown): Promise<void> {
  await setFlag(db, key, value);
}

export async function deleteState(db: Db, key: string): Promise<void> {
  await db.delete(flags).where(eq(flags.key, key));
}

/** Inserts the key only if absent. Returns true if this call created it (idempotency marker). */
export async function claimOnce(db: Db, key: string, value: unknown): Promise<boolean> {
  const rows = await db.insert(flags).values({ key, value }).onConflictDoNothing().returning({ key: flags.key });
  return rows.length === 1;
}

/** Atomic per-key counter (1, 2, 3, ...). */
export async function nextCounter(db: Db, key: string): Promise<number> {
  const [row] = await db
    .insert(flags)
    .values({ key, value: 1 })
    .onConflictDoUpdate({
      target: flags.key,
      set: { value: sql`to_jsonb(((${flags.value} #>> '{}')::bigint + 1))`, updatedAt: new Date() },
    })
    .returning({ value: flags.value });
  return Number(row!.value);
}

/**
 * Telegram delivers webhook updates AT LEAST once: a slow or failed response makes it resend the same update, and
 * the bot then answered every command twice. Claims `update_id` once (insert-or-nothing); false = already handled.
 * Old markers are pruned now and then (they only need to outlive Telegram's retry window).
 */
export async function claimUpdate(db: Db, updateId: number, now: Date = new Date()): Promise<boolean> {
  const rows = await db
    .insert(flags)
    .values({ key: `bot:update:${updateId}`, value: { at: now.toISOString() }, updatedAt: now })
    .onConflictDoNothing()
    .returning({ key: flags.key });
  if (updateId % 50 === 0) {
    await db
      .delete(flags)
      .where(and(like(flags.key, "bot:update:%"), lt(flags.updatedAt, new Date(now.getTime() - 2 * 24 * 3600_000))))
      .catch(() => {});
  }
  return rows.length > 0;
}
