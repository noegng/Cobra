/**
 * Routing engine (plan §6). Deterministic: same input + same quotes => identical output.
 *
 * Pipeline
 *  1. Guards that need no quote: tokenOut known + priced, invoice USD value <= capUsd.
 *  2. Candidates: one per held, non-excluded, verified, priced token (sorted by address).
 *  3. Path selection per candidate: same token => "0x"; else direct paths over every fee tier and two-hop
 *     paths through each hub (default USDT), cheapest exact-output quote at the full amount (or at 1/N of it
 *     if no path can serve the full amount).
 *  4. Cost curves: exact-output quotes at k/N of the invoice (k = 1..N) + a capacity quote (max output from
 *     the whole balance, margin included). A grid point is feasible if the quote succeeds, amountIn+margin
 *     fits the balance and the implied price is within the price guard.
 *  5. Options: every single leg, the optimal grid split with 2 and 3 legs (exact DP), a greedy fill by
 *     marginal cost bounded by balance and depth, and the naive route. Each option is re-quoted at its exact
 *     amounts ("finalised") so the reported cost is never a grid approximation.
 *  6. Pick min(cost + legPenaltyBps * (legs - 1)); ties -> fewer legs -> lexicographic key.
 *
 * Cost = (USD value of quoted amountIn - USD value of amountOut) / USD value of amountOut, at `refRates`.
 * The slippage margin is excluded from cost: it is swapped too and the surplus goes back to the payer
 * (router step 7), so it is not lost.
 */
import { getAddress, type Address, type Hex } from "viem";
import {
  PullKind,
  TOKENS,
  encodePath,
  type Currency,
  type FeeTier,
  type PaymentPlan,
  type PlannedLeg,
  type QuoteSource,
  type SolveResult,
  type SolverInput,
  type TokenInfo,
} from "@cobra/shared";
import type { SolverOptions } from "./index";
import { absBig, ceilDiv, costE2, e2ToBps, minBig, rateToE18, usdE18, usdToE18 } from "./math";

export const QUOTE_TTL_MS = 60_000;
export const DEFAULT_SLIPPAGE_BPS = 50;
export const DEFAULT_MAX_PRICE_DEVIATION_BPS = 200;
/**
 * Per-tokenOut-currency guard defaults. wBRL/USDT on Celo is one-sided and trades ~2.2% above market
 * (5.319 vs 5.437 BRL/USD on 2026-11-02): a 2% guard would refuse every Brazilian payment, so BRL gets 350 bps
 * (2.2% premium + up to ~1.25% impact at the top of the range). ARS stays at 200 bps but REQUIRES the
 * "dólar cripto" reference rate (see fx.ts), not the official one (~7.5% apart).
 */
export const DEFAULT_PRICE_DEVIATION_BPS_BY_CURRENCY: Partial<Record<Currency, number>> = { BRL: 350 };
export const DEFAULT_CAP_USD = 200;
export const DEFAULT_SPLIT_STEPS = 10;
export const DEFAULT_LEG_PENALTY_BPS = 5;
export const DEFAULT_FEE_TIERS: readonly FeeTier[] = [100, 500, 3000, 10000];
export const MAX_LEGS = 3;

type Reason = Extract<SolveResult, { ok: false }>["reason"];

interface Cand {
  idx: number;
  token: Address;
  info: TokenInfo;
  balance: bigint;
  rateE18: bigint;
  same: boolean;
  kind: PullKind;
  path: Hex | null; // null = no route
}

interface GridPoint {
  out: bigint;
  usdIn: bigint | null; // null: quote failed
  fitsBalance: boolean;
  guardOk: boolean;
}

interface LegAlloc {
  c: Cand;
  out: bigint;
}

interface Finalised {
  legs: PlannedLeg[];
  usdIn: bigint;
  costE2: bigint;
  key: string;
  guardOk: boolean;
}

const lower = (a: string) => a.toLowerCase();

/** Small concurrency limiter so a real RPC is not hit with 100 parallel eth_calls. */
function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export async function solveImpl(input: SolverInput, opts: SolverOptions): Promise<SolveResult> {
  const now = opts.now ?? Date.now;
  const quotedAt = now();
  const registry = opts.registry ?? TOKENS;
  const byAddr = new Map(registry.map((t) => [lower(t.address), t] as const));
  const A = input.invoice.amountOut;
  if (typeof A !== "bigint" || A <= 0n) throw new RangeError("invoice.amountOut must be a positive bigint");
  const tokenOut = getAddress(input.invoice.tokenOut);
  const slippageBps = input.prefs?.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) {
    throw new RangeError(`maxSlippageBps must be an integer in [0, 5000], got ${slippageBps}`);
  }
  const m = BigInt(slippageBps);
  const N = opts.splitSteps ?? DEFAULT_SPLIT_STEPS;
  if (!Number.isInteger(N) || N < 1 || N > 100) throw new RangeError("splitSteps must be an integer in [1, 100]");
  const maxLegs = Math.min(MAX_LEGS, Math.max(1, opts.maxLegs ?? MAX_LEGS));
  const legPenaltyE2 = BigInt(Math.round((opts.legPenaltyBps ?? DEFAULT_LEG_PENALTY_BPS) * 100));
  const feeTiers = opts.feeTiers ?? DEFAULT_FEE_TIERS;
  const permit2Ready = new Set((opts.permit2Ready ?? []).map(lower));
  const excluded = new Set((input.prefs?.excludeTokens ?? []).map(lower));
  const limit = limiter(opts.maxConcurrentQuotes ?? 8);

  // Aggregate balances (duplicates summed).
  const balances = new Map<string, bigint>();
  for (const b of input.balances) {
    if (b.amount <= 0n) continue;
    balances.set(lower(b.token), (balances.get(lower(b.token)) ?? 0n) + b.amount);
  }
  const heldOut = balances.get(lower(tokenOut)) ?? 0n;
  const fallback = heldOut > 0n ? ("direct_wfiat" as const) : ("ripio" as const);
  const fail = (reason: Reason, detail: string): SolveResult => ({ ok: false, reason, fallback, detail });

  const rateOf = (t: TokenInfo): bigint | null => {
    const r = t.currency === "USD" ? (input.refRates.USD ?? 1) : input.refRates[t.currency];
    if (r === undefined || !Number.isFinite(r) || r <= 0) return null;
    return rateToE18(r);
  };

  // 1. Guards without quotes.
  const outInfo = byAddr.get(lower(tokenOut));
  if (!outInfo) return fail("no_route", `tokenOut ${tokenOut} not in registry`);
  if (!outInfo.verified) return fail("no_route", `tokenOut ${outInfo.symbol} not verified`);
  const outRate = rateOf(outInfo);
  if (outRate === null) return fail("price_guard", `missing reference rate for ${outInfo.currency}`);
  const usdOutTotal = usdE18(A, outInfo.decimals, outRate);
  if (usdOutTotal <= 0n) return fail("price_guard", "invoice USD value rounds to zero");
  const capE18 = usdToE18(opts.capUsd ?? DEFAULT_CAP_USD);
  if (usdOutTotal > capE18) {
    return fail("over_cap", `invoice ≈ ${fmtUsd(usdOutTotal)} USD > cap ${opts.capUsd ?? DEFAULT_CAP_USD} USD`);
  }
  const maxDev = BigInt(
    opts.maxPriceDeviationBpsByCurrency?.[outInfo.currency] ??
      opts.maxPriceDeviationBps ??
      DEFAULT_PRICE_DEVIATION_BPS_BY_CURRENCY[outInfo.currency] ??
      DEFAULT_MAX_PRICE_DEVIATION_BPS,
  );
  const hubs = (opts.hubTokens ?? registry.filter((t) => t.symbol === "USDT").map((t) => t.address)).map((h) =>
    getAddress(h),
  );

  // 2. Candidates.
  const cands: Cand[] = [];
  const skipped: string[] = [];
  for (const [addr, balance] of [...balances.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const info = byAddr.get(addr);
    if (!info) continue; // unknown token: ignored silently
    if (excluded.has(addr)) continue;
    if (!info.verified) {
      skipped.push(`${info.symbol}:unverified`);
      continue;
    }
    const rateE18 = rateOf(info);
    if (rateE18 === null) {
      skipped.push(`${info.symbol}:no_ref_rate`);
      continue;
    }
    const same = addr === lower(tokenOut);
    cands.push({
      idx: cands.length,
      token: info.address,
      info,
      balance,
      rateE18,
      same,
      kind: pickPullKind(info, permit2Ready),
      path: same ? "0x" : null,
    });
  }
  if (cands.length === 0) {
    return fail("insufficient_balance", `no usable balance${skipped.length ? ` (skipped ${skipped.join(",")})` : ""}`);
  }

  // Quote cache (deterministic: keyed by request, results independent of call order).
  const cache = new Map<string, Promise<bigint | null>>();
  let quoteErrors = 0;
  const q = (dir: "out" | "in", path: Hex, amount: bigint): Promise<bigint | null> => {
    if (amount <= 0n) return Promise.resolve(null);
    const k = `${dir}:${path}:${amount}`;
    let p = cache.get(k);
    if (!p) {
      p = limit(async () => {
        try {
          const v =
            dir === "out"
              ? (await opts.quoter.quoteExactOutput(path, amount)).amountIn
              : (await opts.quoter.quoteExactInput(path, amount)).amountOut;
          return typeof v === "bigint" && v > 0n ? v : null;
        } catch (e) {
          // A QuoterV2 revert (no pool, not enough liquidity) is a definitive "no", not an outage: only transport
          // failures count, so the API can tell "retry later" from "no route, offer Ripio / direct payment".
          if (!(e instanceof Error && (e as { reverted?: unknown }).reverted === true)) quoteErrors++;
          return null;
        }
      });
      cache.set(k, p);
    }
    return p;
  };
  const quotedIn = (c: Cand, out: bigint): Promise<bigint | null> =>
    c.same ? Promise.resolve(out) : c.path ? q("out", c.path, out) : Promise.resolve(null);
  const withMargin = (c: Cand, qin: bigint): bigint => (c.same ? qin : qin + ceilDiv(qin * m, 10_000n));
  const guardOk = (usdIn: bigint, usdOut: bigint): boolean => absBig(usdIn - usdOut) * 10_000n <= maxDev * usdOut;

  // 3. Path selection.
  const unit = A / BigInt(N);
  const directPaths = (c: Cand): Hex[] => feeTiers.map((f) => encodePath([c.token, tokenOut], [f]));
  const allPaths = (c: Cand): Hex[] => {
    const out = directPaths(c);
    for (const h of hubs) {
      if (lower(h) === lower(c.token) || lower(h) === lower(tokenOut)) continue;
      for (const f1 of feeTiers) for (const f2 of feeTiers) out.push(encodePath([c.token, h, tokenOut], [f1, f2]));
    }
    return out;
  };
  const bestPath = async (paths: Hex[], probes: bigint[]): Promise<Hex | null> => {
    for (const amt of probes) {
      if (amt <= 0n) continue;
      const res = await Promise.all(paths.map((p) => q("out", p, amt)));
      let best: { p: Hex; v: bigint } | null = null;
      res.forEach((v, i) => {
        if (v !== null && (best === null || v < best.v)) best = { p: paths[i]!, v };
      });
      if (best) return (best as { p: Hex }).p;
    }
    return null;
  };
  await Promise.all(
    cands.filter((c) => !c.same).map(async (c) => (c.path = await bestPath(allPaths(c), [A, unit]))),
  );
  const routable = cands.filter((c) => c.path !== null);
  if (routable.length === 0) {
    return fail("no_route", `no pool path to ${outInfo.symbol}${quoteErrors ? ` (${quoteErrors} failed quotes)` : ""}`);
  }

  // 4. Cost curves + capacity.
  const grid = new Map<number, GridPoint[]>(); // index k-1
  const capacity = new Map<number, bigint>();
  const gridOut = (k: number): bigint => (k === N ? A : (A * BigInt(k)) / BigInt(N));
  await Promise.all(
    routable.map(async (c) => {
      const pts = await Promise.all(
        Array.from({ length: N }, async (_, i): Promise<GridPoint> => {
          const out = gridOut(i + 1);
          const qin = out > 0n ? await quotedIn(c, out) : null;
          if (qin === null) return { out, usdIn: null, fitsBalance: false, guardOk: false };
          const usdIn = usdE18(qin, c.info.decimals, c.rateE18);
          const usdOut = usdE18(out, outInfo.decimals, outRate);
          return { out, usdIn, fitsBalance: withMargin(c, qin) <= c.balance, guardOk: guardOk(usdIn, usdOut) };
        }),
      );
      grid.set(c.idx, pts);
      // Max output from the whole balance, keeping room for the margin:
      // x + ceil(x*m/1e4) <= balance  <=  x = floor((balance-1) * 1e4 / (1e4+m)).
      let cap = 0n;
      if (c.same) cap = c.balance;
      else {
        const x = ((c.balance - 1n) * 10_000n) / (10_000n + m);
        const viaInput = x > 0n ? await q("in", c.path!, x) : null;
        if (viaInput !== null) cap = viaInput;
        else for (const p of pts) if (p.usdIn !== null && p.fitsBalance && p.out > cap) cap = p.out;
      }
      capacity.set(c.idx, minBig(cap, A));
    }),
  );

  // Exact re-quote of an allocation.
  const finalise = async (alloc: LegAlloc[]): Promise<Finalised | null> => {
    const legsIn = alloc.filter((l) => l.out > 0n);
    if (legsIn.length === 0 || legsIn.length > maxLegs) return null;
    if (new Set(legsIn.map((l) => l.c.idx)).size !== legsIn.length) return null;
    const sum = legsIn.reduce((s, l) => s + l.out, 0n);
    if (sum > A) return null;
    if (sum < A) {
      // Give the rounding remainder to the largest leg (first on ties).
      let bi = 0;
      legsIn.forEach((l, i) => {
        if (l.out > legsIn[bi]!.out) bi = i;
      });
      legsIn[bi] = { c: legsIn[bi]!.c, out: legsIn[bi]!.out + (A - sum) };
    }
    const legs: PlannedLeg[] = [];
    let usdIn = 0n;
    let ok = true;
    for (const l of [...legsIn].sort((a, b) => a.c.idx - b.c.idx)) {
      const qin = await quotedIn(l.c, l.out);
      if (qin === null) return null;
      const amountIn = withMargin(l.c, qin);
      if (amountIn <= 0n || amountIn > l.c.balance) return null; // WS7-7: never emit a zero-amount leg
      const li = usdE18(qin, l.c.info.decimals, l.c.rateE18);
      if (!guardOk(li, usdE18(l.out, outInfo.decimals, outRate))) ok = false;
      usdIn += li;
      legs.push({ token: l.c.token, amountIn, kind: l.c.kind, path: l.c.path!, quotedOut: l.out });
    }
    return {
      legs,
      usdIn,
      costE2: costE2(usdIn, usdOutTotal),
      key: legs.map((l) => `${lower(l.token)}:${l.quotedOut}`).join("|"),
      guardOk: ok,
    };
  };

  // 5. Options.
  const buildOptions = (useGuard: boolean): LegAlloc[][] => {
    const options: LegAlloc[][] = [];
    const feasible = (p: GridPoint) => p.usdIn !== null && p.fitsBalance && (!useGuard || p.guardOk);
    // Singles.
    for (const c of routable) options.push([{ c, out: A }]);
    // Exact DP over the grid: min sum of usdIn with exactly L legs covering N steps.
    type St = { cost: bigint; alloc: [number, number][] };
    let dp = new Map<string, St>([["0:0", { cost: 0n, alloc: [] }]]);
    for (const c of routable) {
      const pts = grid.get(c.idx)!;
      const next = new Map(dp);
      for (const [key, st] of dp) {
        const [l, u] = key.split(":").map(Number) as [number, number];
        if (l >= maxLegs) continue;
        for (let k = 1; k + u <= N; k++) {
          const p = pts[k - 1]!;
          if (!feasible(p)) continue;
          const nk = `${l + 1}:${u + k}`;
          const cost = st.cost + p.usdIn!;
          const cur = next.get(nk);
          if (!cur || cost < cur.cost) next.set(nk, { cost, alloc: [...st.alloc, [c.idx, k]] });
        }
      }
      dp = next;
    }
    for (let L = 2; L <= maxLegs; L++) {
      const st = dp.get(`${L}:${N}`);
      if (st) options.push(st.alloc.map(([idx, k]) => ({ c: cands[idx]!, out: gridOut(k) })));
    }
    // Greedy fill by marginal cost (cost ratio at the first grid step, else at capacity).
    const ratio = (c: Cand): { num: bigint; den: bigint } | null => {
      const p = grid.get(c.idx)![0]!;
      if (p.usdIn !== null && (!useGuard || p.guardOk)) return { num: p.usdIn, den: usdE18(p.out, outInfo.decimals, outRate) };
      return null;
    };
    const ordered = routable
      .map((c) => ({ c, r: ratio(c) }))
      .filter((x): x is { c: Cand; r: { num: bigint; den: bigint } } => x.r !== null && x.r.den > 0n)
      .sort((a, b) => {
        const lhs = a.r.num * b.r.den;
        const rhs = b.r.num * a.r.den;
        return lhs < rhs ? -1 : lhs > rhs ? 1 : a.c.idx - b.c.idx;
      });
    let remaining = A;
    const greedy: LegAlloc[] = [];
    for (const { c } of ordered) {
      if (remaining === 0n || greedy.length >= maxLegs) break;
      const take = minBig(remaining, capacity.get(c.idx) ?? 0n);
      if (take <= 0n) continue;
      greedy.push({ c, out: take });
      remaining -= take;
    }
    if (remaining === 0n) options.push(greedy);
    return options;
  };

  const evaluate = async (useGuard: boolean): Promise<Finalised[]> => {
    const seen = new Set<string>();
    const out: Finalised[] = [];
    for (const alloc of buildOptions(useGuard)) {
      const f = await finalise(alloc);
      if (!f || seen.has(f.key)) continue;
      seen.add(f.key);
      if (useGuard && !f.guardOk) continue;
      out.push(f);
    }
    return out;
  };

  // Naive route: largest USD balance, direct pool (two-hop only if no direct pool exists), whole invoice.
  const naive = async (): Promise<Finalised | null> => {
    let top: Cand | null = null;
    let topUsd = -1n;
    for (const c of cands) {
      const v = usdE18(c.balance, c.info.decimals, c.rateE18);
      if (v > topUsd) [top, topUsd] = [c, v];
    }
    if (!top) return null;
    if (top.same) return finalise([{ c: top, out: A }]);
    const direct = await bestPath(directPaths(top), [A]);
    const path = direct ?? top.path;
    if (!path) return null;
    return finalise([{ c: { ...top, path }, out: A }]);
  };

  const options = await evaluate(true);
  const naiveF = await naive();
  if (naiveF && naiveF.guardOk && !options.some((o) => o.key === naiveF.key && o.legs[0]?.path === naiveF.legs[0]?.path)) {
    options.push(naiveF);
  }

  if (options.length === 0) {
    const relaxed = await evaluate(false);
    if (relaxed.length > 0) {
      return fail("price_guard", `implied price deviates more than ${maxDev} bps from reference (${outInfo.currency})`);
    }
    const usdAvail = routable.reduce((s, c) => s + usdE18(c.balance, c.info.decimals, c.rateE18), 0n);
    return fail(
      "insufficient_balance",
      `need ≈ ${fmtUsd(usdOutTotal)} USD, routable balance ≈ ${fmtUsd(usdAvail)} USD across ${routable.length} token(s)` +
        (quoteErrors ? `, ${quoteErrors} failed quotes` : ""),
    );
  }

  // 6. Choose.
  const score = (f: Finalised) => f.costE2 + legPenaltyE2 * BigInt(f.legs.length - 1);
  options.sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sa < sb ? -1 : 1;
    if (a.legs.length !== b.legs.length) return a.legs.length - b.legs.length;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const best = options[0]!;
  const naiveCost = naiveF ? naiveF.costE2 : null;
  const plan: PaymentPlan = {
    legs: best.legs,
    tokenOut,
    minOut: A,
    costBps: e2ToBps(best.costE2),
    naiveCostBps: naiveCost === null ? null : e2ToBps(naiveCost),
    savingsBps: naiveCost === null ? 0 : e2ToBps(naiveCost - best.costE2),
    quotedAt,
    expiresAt: quotedAt + QUOTE_TTL_MS,
  };
  return { ok: true, plan };
}

/** First pull kind in registry order; PERMIT2 only when the payer already has a Permit2 allowance. */
export function pickPullKind(info: TokenInfo, permit2Ready: ReadonlySet<string>): PullKind {
  for (const k of info.pullKinds) {
    if (k === PullKind.PERMIT2 && !permit2Ready.has(lower(info.address))) continue;
    return k;
  }
  return PullKind.ALLOWANCE;
}

function fmtUsd(e18: bigint): string {
  const cents = e18 / 10n ** 16n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export type { QuoteSource };
