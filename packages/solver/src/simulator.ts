/**
 * Deterministic pool simulator implementing `QuoteSource`, for tests and offline demos.
 *
 * Each pool is a constant-product (x*y=k) pool with a Uniswap-style fee (in hundredths of a bip, so 100 = 0.01%)
 * and a depth limit: a hop that would take more than `maxOutBps` of the output reserve fails, which emulates a
 * concentrated-liquidity position running out of range (QuoterV2 reverts in that case for exact output).
 * Quotes never mutate pool state. Rounding follows Uniswap: exact output rounds the input up, exact input
 * rounds the output down.
 */
import { getAddress, type Address, type Hex } from "viem";
import { decodePath, toBaseUnits, type QuoteSource } from "@cobra/shared";

export interface SimPool {
  tokenA: Address;
  tokenB: Address;
  /** Uniswap fee units (1e-6): 100, 500, 3000, 10000. */
  fee: number;
  reserveA: bigint;
  reserveB: bigint;
  /** Max share of the output reserve one hop may take, in bps. Default 9000 (90%). */
  maxOutBps?: number;
}

export class QuoteError extends Error {
  override name = "QuoteError";
}

const FEE_DENOM = 1_000_000n;

function key(a: Address, b: Address, fee: number): string {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${x}:${y}:${fee}`;
}

export class PoolSimulator implements QuoteSource {
  private readonly pools = new Map<string, SimPool>();
  /** Number of quote calls served (successful or not). */
  calls = 0;

  constructor(pools: readonly SimPool[] = []) {
    for (const p of pools) this.addPool(p);
  }

  addPool(p: SimPool): this {
    if (p.reserveA <= 0n || p.reserveB <= 0n) throw new RangeError("reserves must be positive");
    if (p.fee < 0 || p.fee >= 1_000_000) throw new RangeError("invalid fee");
    this.pools.set(key(p.tokenA, p.tokenB, p.fee), { ...p, tokenA: getAddress(p.tokenA), tokenB: getAddress(p.tokenB) });
    return this;
  }

  private hop(tokenIn: Address, tokenOut: Address, fee: number) {
    const p = this.pools.get(key(tokenIn, tokenOut, fee));
    if (!p) throw new QuoteError(`no pool ${tokenIn}/${tokenOut}/${fee}`);
    const aIsIn = p.tokenA.toLowerCase() === tokenIn.toLowerCase();
    return {
      rIn: aIsIn ? p.reserveA : p.reserveB,
      rOut: aIsIn ? p.reserveB : p.reserveA,
      fee: BigInt(p.fee),
      maxOut: ((aIsIn ? p.reserveB : p.reserveA) * BigInt(p.maxOutBps ?? 9000)) / 10_000n,
    };
  }

  async quoteExactInput(path: Hex, amountIn: bigint): Promise<{ amountOut: bigint }> {
    this.calls++;
    if (amountIn <= 0n) throw new QuoteError("amountIn must be > 0");
    const { tokens, fees } = decodePath(path);
    let amt = amountIn;
    for (let i = 0; i < fees.length; i++) {
      const h = this.hop(tokens[i]!, tokens[i + 1]!, fees[i]!);
      const net = (amt * (FEE_DENOM - h.fee)) / FEE_DENOM;
      const out = (h.rOut * net) / (h.rIn + net);
      if (out > h.maxOut) throw new QuoteError("insufficient liquidity");
      if (out <= 0n) throw new QuoteError("zero output");
      amt = out;
    }
    return { amountOut: amt };
  }

  async quoteExactOutput(path: Hex, amountOut: bigint): Promise<{ amountIn: bigint }> {
    this.calls++;
    if (amountOut <= 0n) throw new QuoteError("amountOut must be > 0");
    const { tokens, fees } = decodePath(path);
    let amt = amountOut;
    for (let i = fees.length - 1; i >= 0; i--) {
      const h = this.hop(tokens[i]!, tokens[i + 1]!, fees[i]!);
      if (amt > h.maxOut) throw new QuoteError("insufficient liquidity");
      const net = (h.rIn * amt + (h.rOut - amt) - 1n) / (h.rOut - amt);
      amt = (net * FEE_DENOM + (FEE_DENOM - h.fee) - 1n) / (FEE_DENOM - h.fee);
    }
    return { amountIn: amt };
  }
}

/**
 * Build a pool from a human price and depth.
 * `price` = units of tokenB per whole tokenA (e.g. wARS per USDT = 1650); `depthA` = whole tokenA in the pool.
 */
export function poolFromPrice(args: {
  tokenA: Address;
  decimalsA: number;
  tokenB: Address;
  decimalsB: number;
  price: number | string;
  depthA: number | string;
  fee?: number;
  maxOutBps?: number;
}): SimPool {
  const reserveA = toBaseUnits(String(args.depthA), args.decimalsA);
  const priceStr = typeof args.price === "number" ? args.price.toFixed(12) : args.price;
  const priceE12 = toBaseUnits(priceStr.replace(/(\.\d{12})\d+$/, "$1"), 12);
  const reserveB = (reserveA * priceE12 * 10n ** BigInt(args.decimalsB)) / (10n ** 12n * 10n ** BigInt(args.decimalsA));
  return {
    tokenA: args.tokenA,
    tokenB: args.tokenB,
    fee: args.fee ?? 100,
    reserveA,
    reserveB,
    ...(args.maxOutBps !== undefined ? { maxOutBps: args.maxOutBps } : {}),
  };
}
