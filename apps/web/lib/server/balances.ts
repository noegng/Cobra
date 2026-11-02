/** Payer balances + Permit2 allowances in one multicall (read-only eth_call). */
import { erc20Abi, getAddress, type Address } from "viem";
import { TOKENS, type TokenBalance } from "@cobra/shared";

export interface PayerChainState {
  balances: TokenBalance[];
  /** allowance(payer, PERMIT2) per token address (checksummed). */
  permit2Allowances: Record<Address, bigint>;
}

/** Minimal surface of a viem PublicClient used here (eases faking in tests). */
export interface MulticallClient {
  multicall(args: {
    contracts: readonly { address: Address; abi: typeof erc20Abi; functionName: "balanceOf" | "allowance"; args: readonly unknown[] }[];
    allowFailure: true;
  }): Promise<readonly ({ status: "success"; result: unknown } | { status: "failure"; error: unknown })[]>;
}

export class BalanceReadError extends Error {
  constructor(symbol: string) {
    super(`balanceOf failed for ${symbol}`);
    this.name = "BalanceReadError";
  }
}

/**
 * Tokens the solver may route through Permit2 (WS2 `permit2Ready`): the existing Permit2 allowance covers the
 * payer's whole balance of that token, hence any amount the solver could pick from it.
 */
export function permit2ReadyTokens(state: PayerChainState): Address[] {
  return state.balances.filter((b) => (state.permit2Allowances[getAddress(b.token)] ?? 0n) >= b.amount).map((b) => getAddress(b.token));
}

export async function readPayerState(client: MulticallClient, payer: Address, permit2: Address): Promise<PayerChainState> {
  const contracts = TOKENS.flatMap((t) => [
    { address: t.address, abi: erc20Abi, functionName: "balanceOf" as const, args: [payer] as const },
    { address: t.address, abi: erc20Abi, functionName: "allowance" as const, args: [payer, permit2] as const },
  ]);
  const res = await client.multicall({ contracts, allowFailure: true });
  const balances: TokenBalance[] = [];
  const permit2Allowances: Record<Address, bigint> = {};
  TOKENS.forEach((t, i) => {
    const bal = res[2 * i];
    const allow = res[2 * i + 1];
    // Fail closed: a missing balance would surface as a misleading "insufficient balance" to the payer.
    if (bal?.status !== "success" || typeof bal.result !== "bigint") throw new BalanceReadError(t.symbol);
    if (bal.result > 0n) balances.push({ token: getAddress(t.address), amount: bal.result });
    permit2Allowances[getAddress(t.address)] = allow?.status === "success" && typeof allow.result === "bigint" ? allow.result : 0n;
  });
  return { balances, permit2Allowances };
}
