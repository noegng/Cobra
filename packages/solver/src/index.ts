/**
 * @cobra/solver — WS2. Pure, deterministic routing engine (plan §6).
 * FROZEN public signatures below; internals are yours.
 */
import type { Address, PublicClient } from "viem";
import type { Currency, FeeTier, QuoteSource, SolveResult, SolverInput, TokenInfo } from "@cobra/shared";
import { solveImpl } from "./solve";
import { createUniswapQuoterImpl } from "./quoter";

export interface SolverOptions {
  quoter: QuoteSource;
  /** Max deviation of implied price vs. refRates, in bps. Default 200 (2%). */
  maxPriceDeviationBps?: number;
  /** Per-payment cap in USD. Default 200. */
  capUsd?: number;
  /** Clock injection for tests (unix ms). */
  now?: () => number;

  // ---- WS2 additions (all optional, backwards compatible) ----
  /**
   * Per-tokenOut-currency price guard, in bps. Precedence: this > maxPriceDeviationBps >
   * DEFAULT_PRICE_DEVIATION_BPS_BY_CURRENCY (BRL: 350) > 200.
   */
  maxPriceDeviationBpsByCurrency?: Partial<Record<Currency, number>>;
  /** Token registry (default `TOKENS` from @cobra/shared). Tests inject fake tokens here. */
  registry?: readonly TokenInfo[];
  /**
   * Tokens for which the payer already has an ERC-20 allowance to Permit2. PERMIT2 is only chosen for these;
   * otherwise the next pull kind in the registry order is used (usually ALLOWANCE).
   */
  permit2Ready?: Address[];
  /** Intermediate tokens for two-hop paths. Default: the registry's USDT. */
  hubTokens?: Address[];
  /** Fee tiers to try per hop. Default [100, 500, 3000, 10000]. */
  feeTiers?: FeeTier[];
  /** Split granularity: quotes at k/N of the invoice, k=1..N. Default 10. */
  splitSteps?: number;
  /** Preference penalty per extra leg (UX: one more signature), in bps. Used for choice only. Default 5. */
  legPenaltyBps?: number;
  /** Max legs (1..3). Default 3 (router limit). */
  maxLegs?: number;
  /** Max concurrent quote requests. Default 8. */
  maxConcurrentQuotes?: number;
}

export async function solve(input: SolverInput, opts: SolverOptions): Promise<SolveResult> {
  return solveImpl(input, opts);
}

/** QuoteSource backed by Uniswap V3 QuoterV2 on Celo (eth_call, read-only). */
export function createUniswapQuoter(client: PublicClient, quoterV2: Address): QuoteSource {
  return createUniswapQuoterImpl(client, quoterV2);
}

export {
  QUOTE_TTL_MS,
  DEFAULT_CAP_USD,
  DEFAULT_LEG_PENALTY_BPS,
  DEFAULT_MAX_PRICE_DEVIATION_BPS,
  DEFAULT_PRICE_DEVIATION_BPS_BY_CURRENCY,
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_SPLIT_STEPS,
  pickPullKind,
} from "./solve";
export { quoterV2Abi, QuoteFailedError } from "./quoter";
export { fetchReferenceRates, createReferenceRateSource, FX_BOUNDS, FX_SOURCES, type FxOptions } from "./fx";
export { PoolSimulator, poolFromPrice, QuoteError, type SimPool } from "./simulator";
