/** Invoice reads and static-QR invoice creation (web-owned queries). */
import { eq } from "drizzle-orm";
import { getAddress, type Address, type Hex } from "viem";
import {
  INVOICE_TTL_SECONDS,
  randomInvoiceId,
  toBaseUnits,
  tokenByAddress,
} from "@cobra/shared";
import { invoices, merchants, type Db, type InvoiceRow } from "@cobra/db";
import { isUsdtAddress, quoteUsdt, type RateSource } from "@cobra/bot/usd";
import type { PublicInvoice } from "../wire";

export type MerchantRow = typeof merchants.$inferSelect;

export async function loadInvoice(db: Db, id: string): Promise<{ invoice: InvoiceRow; merchant: MerchantRow } | null> {
  const rows = await db
    .select({ invoice: invoices, merchant: merchants })
    .from(invoices)
    .innerJoin(merchants, eq(invoices.merchantId, merchants.id))
    // ids are always generated lowercase by randomInvoiceId()
    .where(eq(invoices.id, id.toLowerCase()));
  return rows[0] ?? null;
}

export function effectiveStatus(row: InvoiceRow, now: number): string {
  if (row.status === "open" && row.expiresAt.getTime() <= now) return "expired";
  return row.status;
}

export function toPublicInvoice(row: InvoiceRow, merchant: MerchantRow, now: number): PublicInvoice {
  const token = tokenByAddress(row.tokenOut);
  return {
    id: row.id as Hex,
    merchantName: merchant.displayName?.trim() || "—",
    amountLocal: row.amountLocal,
    currency: row.currency,
    reference: row.reference,
    description: row.description,
    tokenOut: getAddress(row.tokenOut),
    tokenOutSymbol: token?.symbol ?? "?",
    tokenOutDecimals: token?.decimals ?? 18,
    amountOut: row.amountOut,
    payoutAddress: getAddress(row.merchantAddress),
    status: effectiveStatus(row, now),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export class StaticInvoiceError extends Error {
  constructor(
    public readonly code: "merchant_not_found" | "unsupported_settlement" | "rate_unavailable",
    message = code,
  ) {
    super(message);
  }
}

/**
 * Same creation rules as the bot (packages/bot/src/invoices.ts): the invoice is in the merchant's local currency;
 * wFIAT settlement is 1:1 (amountOut = toBaseUnits(amountLocal, decimals)); USD₮ settlement converts at the
 * reference rate read now, rounded up (`quoteUsdt`, packages/bot/src/usd.ts), and refuses without a rate.
 * merchantAddress frozen from the payout address; deadline = now + INVOICE_TTL_SECONDS.
 * `amountLocal` must already be validated/normalised by `parseLocalAmount`.
 */
export async function createStaticInvoice(
  db: Db,
  args: { slug: string; amountLocal: string; now: number; rates?: RateSource },
): Promise<{ id: Hex; merchant: MerchantRow }> {
  const [merchant] = await db.select().from(merchants).where(eq(merchants.staticSlug, args.slug));
  if (!merchant) throw new StaticInvoiceError("merchant_not_found");
  const token = tokenByAddress(merchant.settlementToken);
  const usdt = isUsdtAddress(merchant.settlementToken);
  if (!token || (!usdt && (token.kind !== "wfiat" || token.currency !== merchant.currency))) {
    throw new StaticInvoiceError("unsupported_settlement");
  }
  let amountOut: bigint;
  if (usdt) {
    const q = await quoteUsdt(args.amountLocal, merchant.currency, args.rates);
    if (!q.ok) throw new StaticInvoiceError("rate_unavailable");
    amountOut = q.amountOut;
  } else {
    amountOut = toBaseUnits(args.amountLocal, token.decimals);
  }
  const id = randomInvoiceId();
  await db.insert(invoices).values({
    id,
    merchantId: merchant.id,
    amountLocal: args.amountLocal,
    currency: merchant.currency,
    tokenOut: getAddress(token.address),
    amountOut: amountOut.toString(),
    merchantAddress: getAddress(merchant.payoutAddress as Address),
    reference: `QR-${id.slice(2, 6).toUpperCase()}`,
    description: null,
    status: "open",
    source: "static_qr",
    expiresAt: new Date(args.now + INVOICE_TTL_SECONDS * 1000),
  });
  return { id, merchant };
}
