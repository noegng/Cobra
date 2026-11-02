import { getAddress, type Address } from "viem";
import { PullKind, toBaseUnits, type QuoteSource, type ReferenceRates, type TokenInfo } from "@cobra/shared";
import { PoolSimulator, poolFromPrice, type SimPool } from "../src/simulator";

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

/** Fake tokens. Addresses chosen so sort order is USDC < USDT < ARS < BRL < USDX < MXN. */
export const T = {
  USDC: addr(0x1001),
  USDT: addr(0x1002),
  ARS: addr(0x2001),
  BRL: addr(0x2002),
  USDX: addr(0x3001), // USD token without any pool
  MXN: addr(0x4001), // unverified token
};

const tok = (
  symbol: string,
  address: Address,
  decimals: number,
  currency: TokenInfo["currency"],
  pullKinds: PullKind[],
  verified = true,
): TokenInfo => ({
  symbol,
  address,
  decimals,
  currency,
  kind: currency === "USD" ? "usd" : "wfiat",
  pullKinds,
  eip712: null,
  verified,
});

export const REGISTRY: TokenInfo[] = [
  tok("USDC", T.USDC, 6, "USD", [PullKind.EIP3009, PullKind.PERMIT2, PullKind.ALLOWANCE]),
  tok("USDT", T.USDT, 6, "USD", [PullKind.EIP3009, PullKind.PERMIT2, PullKind.ALLOWANCE]),
  tok("wARS", T.ARS, 18, "ARS", [PullKind.PERMIT2, PullKind.ALLOWANCE]),
  tok("wBRL", T.BRL, 18, "BRL", [PullKind.PERMIT2, PullKind.ALLOWANCE]),
  tok("USDX", T.USDX, 6, "USD", [PullKind.PERMIT2, PullKind.ALLOWANCE]),
  tok("wMXN", T.MXN, 18, "MXN", [PullKind.PERMIT2, PullKind.ALLOWANCE], false),
];

export const ARS_PER_USD = 1650;
export const BRL_PER_USD = 5.4;
export const RATES: ReferenceRates = { USD: 1, ARS: 1 / ARS_PER_USD, BRL: 1 / BRL_PER_USD, MXN: 1 / 18 };

export const usd = (x: string) => toBaseUnits(x, 6);
export const ars = (x: string) => toBaseUnits(x, 18);
export const brl = (x: string) => toBaseUnits(x, 18);

/** Mainnet-like topology: wARS/USDT, wBRL/USDT, USDC/USDT, all 0.01%. CP depths chosen to match observed V3 impact (wARS ~0.03% at $500). */
export function mainnetLikePools(over: { arsDepthUsdt?: number; brlPrice?: number; usdcPrice?: number } = {}): SimPool[] {
  return [
    poolFromPrice({ tokenA: T.USDT, decimalsA: 6, tokenB: T.ARS, decimalsB: 18, price: ARS_PER_USD, depthA: over.arsDepthUsdt ?? 1_500_000, fee: 100 }),
    poolFromPrice({ tokenA: T.USDT, decimalsA: 6, tokenB: T.BRL, decimalsB: 18, price: over.brlPrice ?? BRL_PER_USD, depthA: 50_000, fee: 100 }),
    poolFromPrice({ tokenA: T.USDC, decimalsA: 6, tokenB: T.USDT, decimalsB: 6, price: over.usdcPrice ?? 1, depthA: 5_000_000, fee: 100 }),
  ];
}

export function sim(pools: SimPool[] = mainnetLikePools()): PoolSimulator {
  return new PoolSimulator(pools);
}

export const baseOpts = (quoter: QuoteSource = sim()) => ({
  quoter,
  registry: REGISTRY,
  now: () => 1_700_000_000_000,
});

export function invoiceArs(amount: string) {
  return { tokenOut: T.ARS, amountOut: ars(amount), deadline: 2_000_000_000n };
}
