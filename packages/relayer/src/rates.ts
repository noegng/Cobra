/**
 * USD reference rates used ONLY for risk caps (per-payment / per-day). Never used to compute amounts.
 * ReferenceRates = USD value of one whole unit of a currency (ARS -> 0.0006).
 * The worker feeds these from @cobra/solver's createReferenceRateSource (same rates the solver's price guard uses).
 */
import type { Currency, ReferenceRates } from "@cobra/shared";

export type RatesSource = ReferenceRates | (() => Promise<ReferenceRates>);

export async function resolveRates(src: RatesSource): Promise<ReferenceRates> {
  return typeof src === "function" ? src() : src;
}

/** Fixed-point scale for USD values (1e12) so caps are compared in integers. */
export const USD_SCALE = 10n ** 12n;

/** USD value of `amount` base units (decimals) at `rate` USD/unit, scaled by USD_SCALE. Throws if rate unknown. */
export function usdValueScaled(amount: bigint, decimals: number, currency: Currency, rates: ReferenceRates): bigint {
  const rate = currency === "USD" ? 1 : rates[currency];
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) throw new Error(`missing_rate:${currency}`);
  // rate as an integer with 12 decimals (rates are floats by nature; caps are risk limits, not money movement)
  const rateScaled = BigInt(Math.round(rate * 1e12));
  return (amount * rateScaled) / 10n ** BigInt(decimals);
}

export function usdToScaled(usd: number): bigint {
  return BigInt(Math.round(usd * 1e6)) * 10n ** 6n;
}

export function scaledToUsd(v: bigint): number {
  return Number(v / 10n ** 6n) / 1e6;
}
