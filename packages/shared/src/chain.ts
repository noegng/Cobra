import type { Address } from "viem";

export const CELO_CHAIN_ID = 42220 as const;

/**
 * Celo mainnet protocol addresses.
 * `verified: false` means "taken from docs / memory, NOT yet checked on-chain".
 * Source of truth for verification: docs/research/onchain-verification.md
 */
export const CELO = {
  chainId: CELO_CHAIN_ID,
  rpcUrl: "https://forno.celo.org",
  explorer: "https://celoscan.io",
  permit2: { address: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address, verified: false },
  uniswapV3: {
    factory: { address: null as Address | null, verified: false },
    swapRouter: { address: null as Address | null, verified: false },
    /** "SwapRouter02" => ExactInputParams has no deadline field. */
    swapRouterKind: "SwapRouter02" as "SwapRouter02" | "SwapRouter",
    quoterV2: { address: null as Address | null, verified: false },
  },
  erc8004: {
    identityRegistry: { address: null as Address | null, verified: false },
  },
} as const;

export function explorerTx(hash: string): string {
  return `${CELO.explorer}/tx/${hash}`;
}
export function explorerAddress(addr: string): string {
  return `${CELO.explorer}/address/${addr}`;
}
