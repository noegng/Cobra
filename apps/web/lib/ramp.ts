/**
 * Ripio public on-ramp ("Pagar en pesos" / "Pagar em reais").
 *
 * ramp.ripio.com needs NO partner account. Query params (hackathon docs, checked by hand on 2026-11-03):
 * `country`, `chain`, `token`, `amount`, `address`. With all of country/chain/token/amount the payer lands directly
 * in Ripio's flow; otherwise the params only prefill the form. Ramp countries with Celo: AR, BR, MX, CO (not CL, PE).
 */
import { formatUnits, getAddress, isAddress } from "viem";
import { CELO_CHAIN_ID, COUNTRIES } from "@cobra/shared";

export const RIPIO_ONRAMP_URL = "https://ramp.ripio.com/";

/** Countries where Ripio's public ramp offers Celo (manual check, Plan 3 T9). */
export const RIPIO_RAMP_COUNTRIES = ["AR", "BR", "MX", "CO"] as const;

/** Ramp country for a wFIAT symbol, or null when Ripio has no public ramp there (wCLP, wPEN, stables). */
export function rampCountryForToken(symbol: string): string | null {
  const c = COUNTRIES.find((x) => x.wfiatSymbol.toLowerCase() === symbol.toLowerCase());
  return c && (RIPIO_RAMP_COUNTRIES as readonly string[]).includes(c.country) ? c.country : null;
}

/** Fiat amount for Ripio: wFIAT is 1:1 with the local currency; rounded UP to 2 decimals so the payer never falls short. */
export function rampAmount(amount: bigint, decimals: number): string {
  const cents = (amount * 100n + 10n ** BigInt(decimals) - 1n) / 10n ** BigInt(decimals);
  return formatUnits(cents, 2);
}

/**
 * Prefilled on-ramp link for the payer: buy exactly the invoice's wFIAT on Celo, delivered to the payer's wallet,
 * who then pays the invoice through the router (one signature). Returns null when Ripio has no ramp for the token.
 */
export function buildRipioOnrampUrl(opts: { symbol: string; amount: bigint; decimals: number; payer?: string }): string | null {
  const country = rampCountryForToken(opts.symbol);
  if (!country) return null;
  const q = new URLSearchParams({
    country,
    chain: String(CELO_CHAIN_ID),
    token: opts.symbol.toUpperCase(),
    amount: rampAmount(opts.amount, opts.decimals),
  });
  if (opts.payer && isAddress(opts.payer, { strict: false })) q.set("address", getAddress(opts.payer));
  return `${RIPIO_ONRAMP_URL}?${q.toString()}`;
}
