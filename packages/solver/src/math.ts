/**
 * Fixed-point helpers. All money math is bigint; floats appear only when turning a reference rate
 * (a JS number by the frozen `ReferenceRates` type) into fixed point, and when presenting bps.
 */

/** USD amounts are carried as bigint with 18 decimals. */
export const USD_DECIMALS = 18;
const E18 = 10n ** 18n;

/** Reference rate (USD per whole unit, float) -> 1e18 fixed point. Throws on non-positive / non-finite. */
export function rateToE18(rate: number): bigint {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError(`invalid reference rate ${rate}`);
  // Math.round returns an integral double; BigInt() of it is exact (≈15-16 significant digits of the rate).
  return BigInt(Math.round(rate * 1e18));
}

/** USD value (1e18) of `amount` base units of a token with `decimals`, priced at `rateE18` USD per whole unit. */
export function usdE18(amount: bigint, decimals: number, rateE18: bigint): bigint {
  return (amount * rateE18) / 10n ** BigInt(decimals);
}

/** Whole USD (float, presentation only) -> 1e18 fixed point. */
export function usdToE18(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`invalid USD amount ${usd}`);
  return BigInt(Math.round(usd * 1e6)) * 10n ** 12n;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError("ceilDiv by non-positive");
  return a <= 0n ? a / b : (a + b - 1n) / b;
}

/** Signed cost in hundredths of a bps: (in - out) / out * 1e6. Truncates toward zero (deterministic). */
export function costE2(usdIn: bigint, usdOut: bigint): bigint {
  if (usdOut <= 0n) throw new RangeError("costE2: non-positive output value");
  return ((usdIn - usdOut) * 1_000_000n) / usdOut;
}

/** Hundredths of bps -> bps number with 2 decimals (presentation). */
export function e2ToBps(e2: bigint): number {
  return Number(e2) / 100;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function absBig(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export { E18 };
