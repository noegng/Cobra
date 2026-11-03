/**
 * QuoteSource over Uniswap V3 QuoterV2 (read-only, eth_call).
 *
 * QuoterV2's quote functions are `nonpayable` (they simulate a swap and revert internally), but they do not
 * change state, so an eth_call is enough. The ABI below declares them `view` on purpose: viem then routes
 * them through `readContract`, which honours a client configured with `batch: { multicall: true }`
 * (Multicall3 aggregate3, allowFailure) — one RPC round-trip for a whole solve instead of ~50.
 *
 * Paths: the frozen `QuoteSource` takes swap-direction paths (tokenIn ... tokenOut). QuoterV2.quoteExactOutput
 * expects the REVERSED path (tokenOut ... tokenIn); this adapter reverses it.
 */
import type { Address, Hex, PublicClient } from "viem";
import { reversePath, type QuoteSource } from "@cobra/shared";

export const quoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "view",
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactOutput",
    stateMutability: "view",
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountOut", type: "uint256" },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/**
 * Thrown when a quote cannot be obtained (missing pool, not enough liquidity, RPC failure).
 * `reverted` = the QuoterV2 call itself reverted (no pool / not enough liquidity): a definitive answer, not an
 * outage. RPC/transport failures (timeouts, HTTP 429/5xx) have `reverted: false` and count as outage signals.
 */
export class QuoteFailedError extends Error {
  override name = "QuoteFailedError";
  readonly reverted: boolean;
  constructor(message: string, options?: { cause?: unknown; reverted?: boolean }) {
    super(message, options);
    this.reverted = options?.reverted ?? false;
  }
}

/**
 * True when viem reports an on-chain revert (as opposed to a transport error). Walks `cause` by error NAME, not
 * `instanceof`: the caller's viem client may come from another physical copy of viem (pnpm peer variants).
 */
export function isContractRevert(e: unknown): boolean {
  const revertNames = new Set(["ContractFunctionRevertedError", "ExecutionRevertedError"]);
  for (let x: unknown = e, depth = 0; x && typeof x === "object" && depth < 10; x = (x as { cause?: unknown }).cause, depth++) {
    if (revertNames.has((x as { name?: string }).name ?? "")) return true;
  }
  return false;
}

export function createUniswapQuoterImpl(client: PublicClient, quoterV2: Address): QuoteSource {
  return {
    async quoteExactInput(path: Hex, amountIn: bigint) {
      if (amountIn <= 0n) throw new QuoteFailedError("amountIn must be > 0");
      try {
        const [amountOut] = await client.readContract({
          address: quoterV2,
          abi: quoterV2Abi,
          functionName: "quoteExactInput",
          args: [path, amountIn],
        });
        return { amountOut };
      } catch (cause) {
        throw new QuoteFailedError(`quoteExactInput failed for ${path}`, { cause, reverted: isContractRevert(cause) });
      }
    },
    async quoteExactOutput(path: Hex, amountOut: bigint) {
      if (amountOut <= 0n) throw new QuoteFailedError("amountOut must be > 0");
      try {
        const [amountIn] = await client.readContract({
          address: quoterV2,
          abi: quoterV2Abi,
          functionName: "quoteExactOutput",
          args: [reversePath(path), amountOut],
        });
        return { amountIn };
      } catch (cause) {
        throw new QuoteFailedError(`quoteExactOutput failed for ${path}`, { cause, reverted: isContractRevert(cause) });
      }
    },
  };
}
