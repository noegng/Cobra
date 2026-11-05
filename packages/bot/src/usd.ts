/**
 * USD₮ settlement for a merchant that invoices in its local currency (WS16). Pure, deterministic, bigint only.
 *
 * amountOut (USD₮ base units, 6 decimals) = ceil(amountLocal × 10^6 / localPerUsd).
 *
 * Precision: the reference rate arrives as a float (local units per USD, e.g. 1650.42 ARS). It is converted ONCE to
 * a fixed-point bigint with RATE_DECIMALS = 8 decimals, rounded DOWN (a lower rate means more USD₮ for the merchant).
 * Every later step is exact bigint math, and the final division rounds UP: the merchant never receives less than
 * the local value at the reference rate. Worst-case extra is 1 base unit (0.000001 USD₮) plus the 10^-8 rate
 * truncation (< 10^-10 relative for rates >= 1).
 */
import { toBaseUnits, tokenByAddress, tokenBySymbol, type Currency, type ReferenceRates, type TokenInfo } from "@cobra/shared";
import { formatAmount, type AmountStyle } from "./amount";

export const RATE_DECIMALS = 8;
/** Display symbol of USDT in merchant-facing text. */
export const USDT_DISPLAY = "USD₮";
/** Headroom for local amounts (they carry at most 2 decimals, the web parser too). */
const LOCAL_SCALE = 18;

export type RateSource = () => Promise<ReferenceRates>;

/** The verified registry USDT, or null if it is missing / unverified. */
export function usdtToken(): TokenInfo | null {
  const t = tokenBySymbol("USDT");
  return t && t.kind !== "wfiat" && t.currency === "USD" && t.verified ? t : null;
}

export function isUsdtAddress(address: string | null | undefined): boolean {
  const u = usdtToken();
  return !!u && !!address && address.toLowerCase() === u.address.toLowerCase();
}

/** Float local-per-USD -> fixed-point bigint (RATE_DECIMALS), rounded down. Null if not a sane positive number. */
export function rateToFixed(localPerUsd: number): bigint | null {
  if (!Number.isFinite(localPerUsd) || localPerUsd <= 0) return null;
  const fixed = BigInt(Math.floor(localPerUsd * 10 ** RATE_DECIMALS));
  return fixed > 0n ? fixed : null;
}

/** Local units per USD for `currency` from ReferenceRates (which hold USD per local unit), as fixed-point. */
export function localPerUsdFixed(rates: ReferenceRates, currency: string): bigint | null {
  const usdPerUnit = rates[currency as Currency];
  if (typeof usdPerUnit !== "number" || !Number.isFinite(usdPerUnit) || usdPerUnit <= 0) return null;
  return rateToFixed(1 / usdPerUnit);
}

/** ceil(amountLocal × 10^usdDecimals / localPerUsd), exact. `amountLocal` is a decimal string ("4500.5"). */
export function localToUsdBaseUnits(amountLocal: string, rateFixed: bigint, usdDecimals = 6): bigint {
  if (rateFixed <= 0n) throw new Error("rate must be positive");
  const local = toBaseUnits(amountLocal, LOCAL_SCALE); // amountLocal × 10^18
  const num = local * 10n ** BigInt(usdDecimals) * 10n ** BigInt(RATE_DECIMALS);
  const den = rateFixed * 10n ** BigInt(LOCAL_SCALE);
  return (num + den - 1n) / den;
}

export type UsdQuote = { ok: true; amountOut: bigint; token: TokenInfo } | { ok: false; error: "rate_unavailable" };

/** Fetches the rate once and converts. Any failure (source throws, currency missing) -> rate_unavailable. */
export async function quoteUsdt(amountLocal: string, currency: string, rates: RateSource | undefined): Promise<UsdQuote> {
  const token = usdtToken();
  if (!token || !rates) return { ok: false, error: "rate_unavailable" };
  let r: ReferenceRates;
  try {
    r = await rates();
  } catch {
    return { ok: false, error: "rate_unavailable" };
  }
  const fixed = localPerUsdFixed(r, currency);
  if (fixed === null) return { ok: false, error: "rate_unavailable" };
  return { ok: true, amountOut: localToUsdBaseUnits(amountLocal, fixed, token.decimals), token };
}

/** "2727273" (6 dec) -> "2,73" (comma style): rounded UP to cents, display only. */
export function formatUsdCents(amountOut: bigint | string, decimals: number, style: AmountStyle): string {
  const v = BigInt(amountOut);
  const div = 10n ** BigInt(Math.max(decimals - 2, 0));
  const cents = decimals >= 2 ? (v + div - 1n) / div : v * 10n ** BigInt(2 - decimals);
  return formatAmount(`${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`, "", style).trim();
}

/** Display symbol of a settlement token for merchant-facing text. */
export function displaySymbol(address: string | null | undefined): string {
  if (isUsdtAddress(address)) return USDT_DISPLAY;
  return (address && tokenByAddress(address)?.symbol) || "wFIAT";
}
