/**
 * Small persistent state on top of the `flags` table, so the bot works on stateless serverless webhooks
 * (Vercel): onboarding progress, pending payout-address confirmations, reference counters, daily-close markers.
 */
import { eq, sql } from "drizzle-orm";
import { flags, getFlag, setFlag, type Db } from "@cobra/db";
import type { CountryCode, Language } from "@cobra/shared";

export const stateKeys = {
  onboarding: (telegramUserId: bigint | number) => `bot:onboarding:${telegramUserId}`,
  pendingPayout: (merchantId: string) => `bot:pending_payout:${merchantId}`,
  refSeq: (merchantId: string) => `bot:ref_seq:${merchantId}`,
  dailyClose: (merchantId: string, date: string) => `daily_close:${merchantId}:${date}`,
};

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
