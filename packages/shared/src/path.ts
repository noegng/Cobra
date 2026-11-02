import { concatHex, getAddress, numberToHex, sliceHex, hexToNumber, size, type Address, type Hex } from "viem";

/** Uniswap V3 fee tiers. */
export type FeeTier = 100 | 500 | 3000 | 10000;

/**
 * Encode a Uniswap V3 path in swap direction (tokenIn ... tokenOut):
 * token(20) | fee(3) | token(20) | ...
 * NOTE: QuoterV2.quoteExactOutput expects the REVERSED path; the solver's quoter adapter handles that.
 */
export function encodePath(tokens: readonly Address[], fees: readonly FeeTier[]): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) throw new Error("invalid path shape");
  const parts: Hex[] = [];
  tokens.forEach((t, i) => {
    parts.push(getAddress(t));
    if (i < fees.length) parts.push(numberToHex(fees[i]!, { size: 3 }));
  });
  return concatHex(parts);
}

export function decodePath(path: Hex): { tokens: Address[]; fees: number[] } {
  const len = size(path);
  if (len < 43 || (len - 20) % 23 !== 0) throw new Error("invalid path length");
  const tokens: Address[] = [];
  const fees: number[] = [];
  let o = 0;
  for (;;) {
    tokens.push(getAddress(sliceHex(path, o, o + 20)));
    o += 20;
    if (o >= len) break;
    fees.push(hexToNumber(sliceHex(path, o, o + 3)));
    o += 3;
  }
  return { tokens, fees };
}

/** Reverse a path (for exact-output quoting / swaps). */
export function reversePath(path: Hex): Hex {
  const { tokens, fees } = decodePath(path);
  return encodePath([...tokens].reverse(), [...fees].reverse() as FeeTier[]);
}
