/**
 * Textile FX RFQ route (docs/interfaces.md §7), layered on top of the Uniswap solver.
 *
 * Runs only when `SolverOptions.textile` is set (API key + v2 router configured). Single hop USD₮ -> wFIAT, exact
 * output. Flow: preview (free, indicative) -> compare cost with the best Uniswap plan (same cost metric and price
 * guard) -> only if better, firm request with taker = router v2 -> re-check every field of the firm quote -> single-leg
 * plan whose `path` carries the signed Textile orders. Anything unexpected drops Textile (and gives the quote back).
 */
import { getAddress, isAddressEqual, type Address } from "viem";
import {
  CELO_CHAIN_ID,
  TEXTILE_REACTOR_CELO,
  TOKENS,
  encodeTextileVenue,
  type PaymentPlan,
  type SolveResult,
  type SolverInput,
  type TokenInfo,
} from "@cobra/shared";
import type { SolverOptions } from "./index";
import { absBig, costE2, e2ToBps, rateToE18, usdE18, usdToE18 } from "./math";
import { DEFAULT_CAP_USD, QUOTE_TTL_MS, maxDeviationBps, pickPullKind } from "./solve";
import type { TextileClient } from "./textile";

/** Plan/quote expiry = Textile `expiresAt` minus this margin (signing + relaying time). */
export const TEXTILE_EXPIRY_MARGIN_MS = 20_000;
/** A Textile quote must still have this much life after the margin, else it is not worth offering. */
export const TEXTILE_MIN_REMAINING_MS = 25_000;
/** wFIAT / stable corridors Textile quotes against USD₮ on Celo (symbols resolved in the registry). */
export const DEFAULT_TEXTILE_CORRIDOR_SYMBOLS = ["wARS", "wBRL", "wCOP", "cNGN", "IDRX", "USDC"] as const;

export interface TextileRouteOptions {
  client: TextileClient;
  /** CobraRouterV2 address: the RFQ `taker`. */
  router: Address;
  chainId?: number;
  /** tokenOut addresses with a Textile corridor. Default: DEFAULT_TEXTILE_CORRIDOR_SYMBOLS found in the registry. */
  corridors?: readonly Address[];
  /** Reactor the quote must name. Default TEXTILE_REACTOR_CELO. */
  reactor?: Address;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export type PlanVenue = "textile" | "uniswap_v3";
export interface PlanMeta {
  venue: PlanVenue;
  textile?: { rfqId: string; expiresAt: number; takerPays: string };
}
/** SolveResult plus routing metadata (additive, never part of the frozen shape: callers may ignore `meta`). */
export type SolveResultEx = SolveResult & { meta?: PlanMeta };

const lower = (a: string) => a.toLowerCase();

export async function solveWithTextile(input: SolverInput, opts: SolverOptions, uni: SolveResult): Promise<SolveResultEx> {
  const tx = opts.textile;
  if (!tx || !tx.client.enabled) return uni;
  const log = tx.log ?? (() => {});
  const drop = (why: string, extra?: Record<string, unknown>): SolveResultEx => {
    log("textile_dropped", { why, ...extra });
    return uni.ok ? { ...uni, meta: { venue: "uniswap_v3" } } : uni;
  };
  if (!uni.ok && uni.reason === "over_cap") return uni;

  const now = opts.now ?? Date.now;
  const registry = opts.registry ?? TOKENS;
  const byAddr = new Map(registry.map((t) => [lower(t.address), t] as const));
  const A = input.invoice.amountOut;
  const tokenOut = getAddress(input.invoice.tokenOut);
  const outInfo = byAddr.get(lower(tokenOut));
  if (!outInfo?.verified) return drop("tokenOut_not_verified");

  const corridors = new Set(
    (tx.corridors ?? DEFAULT_TEXTILE_CORRIDOR_SYMBOLS.map((s) => registry.find((t) => t.symbol === s)?.address).filter((a): a is Address => !!a)).map(lower),
  );
  if (!corridors.has(lower(tokenOut))) return drop("no_corridor");

  const usdt: TokenInfo | undefined = registry.find((t) => t.symbol === "USDT" && t.verified);
  if (!usdt) return drop("no_usdt");
  if ((input.prefs?.excludeTokens ?? []).some((t) => lower(t) === lower(usdt.address))) return drop("usdt_excluded");
  if (lower(usdt.address) === lower(tokenOut)) return drop("tokenOut_is_usdt");

  let balance = 0n;
  for (const b of input.balances) if (lower(b.token) === lower(usdt.address) && b.amount > 0n) balance += b.amount;
  if (balance <= 0n) return drop("no_usdt_balance");

  const rate = (t: TokenInfo): bigint | null => {
    const r = t.currency === "USD" ? (input.refRates.USD ?? 1) : input.refRates[t.currency];
    return r !== undefined && Number.isFinite(r) && r > 0 ? rateToE18(r) : null;
  };
  const outRate = rate(outInfo);
  const inRate = rate(usdt);
  if (outRate === null || inRate === null) return drop("no_ref_rate");
  const usdOut = usdE18(A, outInfo.decimals, outRate);
  if (usdOut <= 0n) return drop("zero_value");
  if (usdOut > usdToE18(opts.capUsd ?? DEFAULT_CAP_USD)) return drop("over_cap");
  const maxDev = BigInt(maxDeviationBps(opts, outInfo.currency));

  /** cost (hundredths of bps) of paying `takerPays` USD₮, or null if outside the price guard. */
  const evalCost = (takerPays: bigint): bigint | null => {
    const usdIn = usdE18(takerPays, usdt.decimals, inRate);
    if (absBig(usdIn - usdOut) * 10_000n > maxDev * usdOut) return null;
    return costE2(usdIn, usdOut);
  };
  const uniE2 = uni.ok ? BigInt(Math.round(uni.plan.costBps * 100)) : null;
  const better = (c: bigint) => uniE2 === null || c < uniE2;

  const chainId = tx.chainId ?? CELO_CHAIN_ID;
  const swap = { chainId, sellToken: usdt.address, buyToken: tokenOut, buyAmount: A };

  // 1. Indicative price (free, no taker).
  const pre = await tx.client.preview(swap);
  if (!pre.ok) return drop(`preview_${pre.reason}`);
  if (pre.value.buyAmount !== A) return drop("preview_amount_mismatch");
  if (pre.value.takerPays <= 0n || pre.value.takerPays > balance) return drop("preview_balance");
  const preCost = evalCost(pre.value.takerPays);
  if (preCost === null) return drop("preview_price_guard");
  if (!better(preCost)) return drop("preview_not_better", { preCostE2: preCost.toString(), uniE2: uniE2?.toString() });

  // 2. Firm quote, taker = router v2.
  const firm = await tx.client.request({ ...swap, taker: tx.router });
  if (!firm.ok) return drop(`request_${firm.reason}`);
  const { rfqId, quote } = firm.value;
  const giveBack = (why: string, extra?: Record<string, unknown>): SolveResultEx => {
    void tx.client.cancel(rfqId).catch(() => undefined);
    return drop(why, extra);
  };

  // 3. Check every field of the firm quote (never trust the response).
  if (!isAddressEqual(getAddress(quote.taker), tx.router)) return giveBack("wrong_taker");
  if (!isAddressEqual(getAddress(quote.reactor), tx.reactor ?? TEXTILE_REACTOR_CELO)) return giveBack("wrong_reactor");
  if (quote.buyAmount !== A) return giveBack("buy_amount_mismatch");
  if (quote.takerPays <= 0n || quote.takerPays > balance) return giveBack("taker_pays_balance");
  const orderOut = quote.orders.reduce((s, o) => (s === null || o.buyAmount === undefined ? null : s + o.buyAmount), 0n as bigint | null);
  if (orderOut !== null && orderOut !== A) return giveBack("orders_amount_mismatch");
  const firmCost = evalCost(quote.takerPays);
  if (firmCost === null) return giveBack("firm_price_guard");
  if (!better(firmCost)) return giveBack("firm_not_better");

  const quotedAt = now();
  const expiresAt = Math.min(quotedAt + QUOTE_TTL_MS, quote.expiresAt - TEXTILE_EXPIRY_MARGIN_MS);
  if (expiresAt - quotedAt < TEXTILE_MIN_REMAINING_MS) return giveBack("quote_too_short");

  const naive = uni.ok ? uni.plan.naiveCostBps : null;
  const costBps = e2ToBps(firmCost);
  const plan: PaymentPlan = {
    legs: [
      {
        token: usdt.address,
        amountIn: quote.takerPays,
        kind: pickPullKind(usdt, new Set((opts.permit2Ready ?? []).map(lower))),
        path: encodeTextileVenue(quote.orders.map((o) => ({ order: o.encodedOrder as `0x${string}`, sig: o.signature as `0x${string}` }))),
        quotedOut: A,
      },
    ],
    tokenOut,
    minOut: A,
    costBps,
    naiveCostBps: naive,
    savingsBps: naive === null ? 0 : e2ToBps(BigInt(Math.round(naive * 100)) - firmCost),
    quotedAt,
    expiresAt,
  };
  log("textile_selected", { rfqId, costBps, uniCostBps: uni.ok ? uni.plan.costBps : null });
  return { ok: true, plan, meta: { venue: "textile", textile: { rfqId, expiresAt: quote.expiresAt, takerPays: quote.takerPays.toString() } } };
}
