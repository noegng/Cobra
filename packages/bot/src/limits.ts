/**
 * Charge size in dollars, so a typo or a unit mix-up ("4500" meant as dollars, one zero too many) is caught before
 * the invoice exists. Pure bigint math on top of usd.ts; the reference rate is the same source as USD₮ settlement.
 *
 *  - over:    above the relayer's per-payment cap (flags.caps.perPaymentUsd, default 200). Nobody could pay it:
 *             refused, with the dollar value so the merchant sees the mistake.
 *  - confirm: from half the cap up to the cap: created only after a "yes" button.
 *  - ok:      below that.
 *  - unknown: no rate right now. Not blocking (the relayer re-checks the cap at payment time); no dollar hint shown.
 */
import { DEFAULT_CAPS, getCaps, type Db } from "@cobra/db";
import { localPerUsdFixed, localToUsdBaseUnits, type RateSource } from "./usd";

/** USD micro-units (6 decimals), the USD₮ scale. */
const USD_DECIMALS = 6;

export type ChargeSize =
  | { kind: "unknown" }
  | { kind: "ok" | "confirm" | "over"; usdMicro: bigint; maxUsd: number };

/** Dollar value of a local amount at the reference rate (rounded up), or null without a rate. */
export async function usdValueMicro(amountLocal: string, currency: string, rates: RateSource | undefined): Promise<bigint | null> {
  if (!rates) return null;
  try {
    const fixed = localPerUsdFixed(await rates(), currency);
    return fixed === null ? null : localToUsdBaseUnits(amountLocal, fixed, USD_DECIMALS);
  } catch {
    return null;
  }
}

export async function chargeSize(db: Db, amountLocal: string, currency: string, rates: RateSource | undefined): Promise<ChargeSize> {
  const usdMicro = await usdValueMicro(amountLocal, currency, rates);
  if (usdMicro === null) return { kind: "unknown" };
  let maxUsd = DEFAULT_CAPS.perPaymentUsd;
  try {
    maxUsd = (await getCaps(db)).perPaymentUsd ?? maxUsd;
  } catch {
    // keep the default cap
  }
  const maxMicro = BigInt(Math.round(maxUsd * 10 ** USD_DECIMALS));
  const kind = usdMicro > maxMicro ? "over" : usdMicro * 2n >= maxMicro ? "confirm" : "ok";
  return { kind, usdMicro, maxUsd };
}
