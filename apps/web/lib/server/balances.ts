/** Payer balances + Permit2 allowances in one multicall (read-only eth_call). */
import { BaseError, erc20Abi, getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
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

/** EIP-7702 delegation designator: code is exactly 0xef0100 followed by a 20-byte address. */
export function isEip7702Delegation(code: string | undefined | null): boolean {
  return !!code && /^0xef0100[0-9a-fA-F]{40}$/.test(code);
}

const ERC1271_MAGIC = "0x1626ba7e";
const erc1271Abi = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);

/** ERC-1271 check on the account itself (eth_call). A revert or any other return value = rejected. */
export async function accountAcceptsSignature(
  client: Pick<PublicClient, "readContract">,
  account: Address,
  hash: Hex,
  signature: Hex,
): Promise<boolean> {
  try {
    const r = await client.readContract({ address: account, abi: erc1271Abi, functionName: "isValidSignature", args: [hash, signature] });
    return r.toLowerCase() === ERC1271_MAGIC;
  } catch (e) {
    // A revert is an answer (rejected); a transport failure is not: let it propagate (→ 502, payer retries).
    if (e instanceof BaseError && e.walk((x) => ["ContractFunctionZeroDataError", "ContractFunctionRevertedError"].includes((x as Error).name))) return false;
    throw e;
  }
}
