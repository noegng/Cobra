/**
 * ALLOWANCE fallback (docs/interfaces.md §2.4 / §3): the payer sends `pay` THEMSELVES (msg.sender == payer),
 * e.g. when the wallet cannot sign EIP-712 or the plan needs Permit2 without a prior approval.
 * Steps: approve(router, amountIn) per leg token (if needed) → router.pay(inv, payer, legs[kind=ALLOWANCE]).
 * Every tx carries the ERC-8021 attribution suffix (NEXT_PUBLIC_ATTRIBUTION_CODE, Schema 0 via
 * @celo/attribution-tags `toDataSuffix`). Gas: no wFIAT is a Celo fee currency, so we pass the
 * fee-currency ADAPTER of a USD stable the payer uses (CELO.feeCurrency), else native CELO.
 * The indexer then sees the Paid log and moves the invoice open → paid (no submissions row).
 */
import { toDataSuffix } from "@celo/attribution-tags";
import { concatHex, encodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from "viem";
import { CELO, PullKind, cobraRouterAbi, tokenByAddress, type Leg, type OnchainInvoice } from "@cobra/shared";
import type { WireOnchainInvoice } from "./wire";

const CODE_RE = /^[a-z0-9_]{1,32}$/;

export function attributionSuffix(code: string | undefined): Hex | null {
  if (!code || !CODE_RE.test(code)) return null;
  return toDataSuffix(code) as Hex;
}

export function withSuffix(data: Hex, suffix: Hex | null): Hex {
  return suffix ? concatHex([data, suffix]) : data;
}

export function invoiceFromWire(w: WireOnchainInvoice): OnchainInvoice {
  return { id: w.id, merchant: getAddress(w.merchant), tokenOut: getAddress(w.tokenOut), amountOut: BigInt(w.amountOut), deadline: BigInt(w.deadline) };
}

export function allowanceLegs(legs: readonly { token: string; amountIn: string | bigint; path: string }[]): Leg[] {
  return legs.map((l) => ({
    token: getAddress(l.token),
    amountIn: BigInt(l.amountIn),
    kind: PullKind.ALLOWANCE,
    pullData: "0x",
    path: l.path as Hex,
  }));
}

export function payCalldata(inv: OnchainInvoice, payer: Address, legs: readonly Leg[], suffix: Hex | null): Hex {
  return withSuffix(encodeFunctionData({ abi: cobraRouterAbi, functionName: "pay", args: [inv, payer, legs] }), suffix);
}

export function approveCalldata(spender: Address, amount: bigint, suffix: Hex | null): Hex {
  return withSuffix(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }), suffix);
}

/** Fee-currency adapter for gas, preferring a USD stable that is part of the payment. */
export function feeCurrencyFor(tokens: readonly string[]): Address | undefined {
  const syms = tokens.map((t) => tokenByAddress(t)?.symbol);
  if (syms.includes("USDT")) return CELO.feeCurrency.USDT;
  if (syms.includes("USDC")) return CELO.feeCurrency.USDC;
  if (syms.includes("USAT")) return CELO.feeCurrency.USAT;
  return undefined; // pay gas in CELO
}

export interface AllowanceTx {
  label: string;
  to: Address;
  data: Hex;
  token?: Address;
  amount?: bigint;
  kind: "approve" | "pay";
}

/** Ordered tx list; `currentAllowances[token]` = allowance(payer, router) read by the page. */
export function allowancePlan(args: {
  invoice: OnchainInvoice;
  payer: Address;
  router: Address;
  legs: readonly Leg[];
  currentAllowances: Record<string, bigint>;
  attributionCode?: string;
}): AllowanceTx[] {
  const suffix = attributionSuffix(args.attributionCode);
  const txs: AllowanceTx[] = [];
  for (const leg of args.legs) {
    const have = args.currentAllowances[getAddress(leg.token)] ?? 0n;
    if (have < leg.amountIn) {
      txs.push({
        kind: "approve",
        label: tokenByAddress(leg.token)?.symbol ?? leg.token,
        to: leg.token,
        token: leg.token,
        amount: leg.amountIn,
        data: approveCalldata(args.router, leg.amountIn, suffix),
      });
    }
  }
  txs.push({ kind: "pay", label: "pay", to: args.router, data: payCalldata(args.invoice, args.payer, args.legs, suffix) });
  return txs;
}
