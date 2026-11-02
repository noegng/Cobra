/** Shared, frozen DB helpers (WS0). Package-specific queries live in each package. */
import { and, eq, inArray } from "drizzle-orm";
import { getAddress, type Hex } from "viem";
import { canTransition, type InvoiceStatus, type OnchainInvoice } from "@cobra/shared";
import type { Db } from "./client";
import { FLAG_KEYS, flags, invoices } from "./schema";

export type InvoiceRow = typeof invoices.$inferSelect;

/** The exact on-chain Invoice struct for a DB row (docs/interfaces.md §4). */
export function onchainInvoiceFromRow(row: InvoiceRow): OnchainInvoice {
  return {
    id: row.id as Hex,
    merchant: getAddress(row.merchantAddress),
    tokenOut: getAddress(row.tokenOut),
    amountOut: BigInt(row.amountOut),
    deadline: BigInt(Math.floor(row.expiresAt.getTime() / 1000)),
  };
}

/**
 * Atomic conditional transition: only applies if the current status is one of `from`
 * and the shared state machine allows `from -> to`. Returns the updated row, or null if nothing changed.
 */
export async function transitionInvoice(
  db: Db,
  id: string,
  from: readonly InvoiceStatus[],
  to: InvoiceStatus,
  extra: Partial<Pick<InvoiceRow, "paidAt">> = {},
): Promise<InvoiceRow | null> {
  const allowed = from.filter((f) => canTransition(f, to));
  if (allowed.length === 0) throw new Error(`illegal transition ${from.join("|")} -> ${to}`);
  const [row] = await db
    .update(invoices)
    .set({ status: to, ...extra })
    .where(and(eq(invoices.id, id), inArray(invoices.status, allowed)))
    .returning();
  return row ?? null;
}

export async function getFlag<T>(db: Db, key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(flags).where(eq(flags.key, key));
  return row ? (row.value as T) : fallback;
}

export async function setFlag(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(flags)
    .values({ key, value })
    .onConflictDoUpdate({ target: flags.key, set: { value, updatedAt: new Date() } });
}

/** Kill switch: env KILL_SWITCH=true OR flags.kill_switch.enabled. Checked before every send. */
export async function isKillSwitchOn(db: Db, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (env.KILL_SWITCH === "true") return true;
  return (await getFlag<{ enabled: boolean }>(db, FLAG_KEYS.killSwitch, { enabled: false })).enabled;
}

export interface Caps {
  perPaymentUsd: number;
  perDayUsd: number;
}
export const DEFAULT_CAPS: Caps = { perPaymentUsd: 200, perDayUsd: 2000 };
export async function getCaps(db: Db): Promise<Caps> {
  return getFlag<Caps>(db, FLAG_KEYS.caps, DEFAULT_CAPS);
}
