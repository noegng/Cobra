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
    if (bal?.status === "success" && typeof bal.result === "bigint" && bal.result > 0n) {
      balances.push({ token: getAddress(t.address), amount: bal.result });
    }
    permit2Allowances[getAddress(t.address)] = allow?.status === "success" && typeof allow.result === "bigint" ? allow.result : 0n;
  });
  return { balances, permit2Allowances };
}
