/**
 * Wallet-ownership proof, server side. Nonces and results live in the `flags` table (no schema change):
 *   verify_nonce:<merchantId> -> { nonce, expiresAt }   (one pending nonce per merchant, single use)
 *   merchant_verified:<merchantId> -> { address, at }
 * Signature check goes through a viem public client so ERC-1271 / ERC-6492 smart wallets work.
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getAddress, isAddress, isHex, type Hex } from "viem";
import { flags, merchants, type Db } from "@cobra/db";
import { VERIFY_NONCE_RE, VERIFY_NONCE_TTL_MS, buildVerifyMessage } from "../verify-core";

export const nonceKey = (merchantId: string) => `verify_nonce:${merchantId}`;
export const verifiedKey = (merchantId: string) => `merchant_verified:${merchantId}`;

export interface VerifyDeps {
  db: Db;
  now: () => number;
  verifyMessage: (args: { address: `0x${string}`; message: string; signature: Hex }) => Promise<boolean>;
}

type Merchant = { id: string; displayName: string | null; payoutAddress: string };

async function findMerchant(db: Db, slug: string): Promise<Merchant | null> {
  const [m] = await db
    .select({ id: merchants.id, displayName: merchants.displayName, payoutAddress: merchants.payoutAddress })
    .from(merchants)
    .where(eq(merchants.staticSlug, slug));
  return m ?? null;
}

export async function issueNonce(deps: VerifyDeps, slug: string, domain: string) {
  const m = await findMerchant(deps.db, slug);
  if (!m) return null;
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = deps.now() + VERIFY_NONCE_TTL_MS;
  const value = { nonce, expiresAt };
  await deps.db
    .insert(flags)
    .values({ key: nonceKey(m.id), value })
    .onConflictDoUpdate({ target: flags.key, set: { value, updatedAt: new Date() } });
  const message = buildVerifyMessage({ slug, payoutAddress: m.payoutAddress, domain, nonce, expiresAt });
  return { nonce, expiresAt, message, payoutAddress: m.payoutAddress, displayName: m.displayName };
}

export type VerifyOutcome = "ok" | "not_found" | "bad_request" | "nonce_invalid" | "bad_signature";

export async function checkSignature(
  deps: VerifyDeps,
  slug: string,
  domain: string,
  nonce: unknown,
  signature: unknown,
): Promise<VerifyOutcome> {
  if (typeof nonce !== "string" || !VERIFY_NONCE_RE.test(nonce)) return "bad_request";
  if (typeof signature !== "string" || !isHex(signature) || signature.length > 20_000) return "bad_request";
  const m = await findMerchant(deps.db, slug);
  if (!m || !isAddress(m.payoutAddress, { strict: false })) return "not_found";

  // Consume the nonce first (single use, even when the signature turns out wrong). Atomic delete ... returning.
  const [row] = await deps.db.delete(flags).where(eq(flags.key, nonceKey(m.id))).returning();
  const stored = row?.value as { nonce?: string; expiresAt?: number } | undefined;
  if (!stored || stored.nonce !== nonce || typeof stored.expiresAt !== "number" || stored.expiresAt < deps.now()) {
    return "nonce_invalid";
  }
  const address = getAddress(m.payoutAddress);
  const message = buildVerifyMessage({ slug, payoutAddress: m.payoutAddress, domain, nonce, expiresAt: stored.expiresAt });
  let valid = false;
  try {
    valid = await deps.verifyMessage({ address, message, signature });
  } catch {
    valid = false;
  }
  if (!valid) return "bad_signature";

  const at = new Date(deps.now()).toISOString();
  const value = { address, at };
  await deps.db
    .insert(flags)
    .values({ key: verifiedKey(m.id), value })
    .onConflictDoUpdate({ target: flags.key, set: { value, updatedAt: new Date() } });
  await deps.db
    .update(merchants)
    .set({ payoutAddressProven: 1 })
    .where(and(eq(merchants.id, m.id), eq(merchants.payoutAddress, m.payoutAddress)));
  return "ok";
}

export async function isVerified(db: Db, merchantId: string, payoutAddress: string): Promise<boolean> {
  const [row] = await db.select().from(flags).where(eq(flags.key, verifiedKey(merchantId)));
  const v = row?.value as { address?: string } | undefined;
  return !!v?.address && v.address.toLowerCase() === payoutAddress.toLowerCase();
}
