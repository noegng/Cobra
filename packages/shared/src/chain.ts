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
  permit2: { address: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address, verified: true },
  uniswapV3: {
    factory: { address: "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc" as Address, verified: true },
    /** SwapRouter02: ExactInputParams has NO deadline field; WETH9() == 0 on Celo. */
    swapRouter: { address: "0x5615CDAb10dc425a742d643d949a7F474C01abc4" as Address, verified: true },
    swapRouterKind: "SwapRouter02" as const,
    quoterV2: { address: "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8" as Address, verified: true },
  },
  /** Verified pools (all 0.01% fee tier). No wFIAT/USDC pool: USDC routes USDC→USDT→wFIAT. */
  pools: {
    wARS_USDT: { address: "0x5D8ef8B839be522b9E3d60a51EDB5837CD0b2391" as Address, fee: 100 },
    // One-sided (~$27.7k wBRL / ~23 USDT), priced ~2.2% worse than market: buying wBRL OK, selling impossible.
    wBRL_USDT: { address: "0x01c3cf91cdf7B34181C7eC8566c0236951FEA40F" as Address, fee: 100 },
    USDC_USDT: { address: "0x1a810e0B6c2dd5629AFa2f0c898b9512C6F78846" as Address, fee: 100 },
    USAT_USDT: { address: "0x070D575a713EaF5025462D0865Fb0Dac4B14bC38" as Address, fee: 100 },
  },
  /** Celo fee abstraction: no wFIAT is a fee currency. Pass the ADAPTER as feeCurrency for 6-dec stables. */
  feeCurrency: {
    directory: "0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276" as Address,
    USDC: "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B" as Address,
    USDT: "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72" as Address,
    USAT: "0x0357EE22278c922e1D36cFe6b899269b161880C4" as Address,
  },
  erc8004: {
    identityRegistry: { address: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address, verified: true },
    reputationRegistry: { address: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Address, verified: true },
  },
} as const;

export function explorerTx(hash: string): string {
  return `${CELO.explorer}/tx/${hash}`;
}
export function explorerAddress(addr: string): string {
  return `${CELO.explorer}/address/${addr}`;
}
