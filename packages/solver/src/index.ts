/**
 * @cobra/solver — WS2. Pure, deterministic routing engine (plan §6).
 * FROZEN public signatures below; internals are yours.
 */
import type { Address, PublicClient } from "viem";
import type { QuoteSource, SolveResult, SolverInput } from "@cobra/shared";

export interface SolverOptions {
  quoter: QuoteSource;
  /** Max deviation of implied price vs. refRates, in bps. Default 200 (2%). */
  maxPriceDeviationBps?: number;
  /** Per-payment cap in USD. Default 200. */
  capUsd?: number;
  /** Clock injection for tests (unix ms). */
  now?: () => number;
}

export async function solve(_input: SolverInput, _opts: SolverOptions): Promise<SolveResult> {
  throw new Error("not implemented (WS2)");
}

/** QuoteSource backed by Uniswap V3 QuoterV2 on Celo (eth_call, read-only). */
export function createUniswapQuoter(_client: PublicClient, _quoterV2: Address): QuoteSource {
  throw new Error("not implemented (WS2)");
}
