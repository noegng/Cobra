/**
 * FROZEN INTERFACES (WS0). Any change here must be listed in your night report
 * under "Interface changes" and agreed before merge.
 */
import type { Address, Hex } from "viem";

/** Mirrors `enum PullKind` in ICobraRouter.sol (uint8). Order is ABI-significant. */
export const PullKind = {
  EIP3009: 0,
  PERMIT2: 1,
  ALLOWANCE: 2,
} as const;
export type PullKind = (typeof PullKind)[keyof typeof PullKind];

export type CountryCode = "AR" | "BR" | "MX" | "CO" | "CL" | "PE";
export type FiatCurrency = "ARS" | "BRL" | "MXN" | "COP" | "CLP" | "PEN";
export type Currency = FiatCurrency | "USD";
export type Language = "es" | "pt" | "en";

/** On-chain invoice, mirrors `struct Invoice` in ICobraRouter.sol. */
export interface OnchainInvoice {
  id: Hex; // bytes32
  merchant: Address;
  tokenOut: Address;
  amountOut: bigint; // base units of tokenOut
  deadline: bigint; // unix seconds
}

/** On-chain leg, mirrors `struct Leg` in ICobraRouter.sol. */
export interface Leg {
  token: Address;
  amountIn: bigint;
  kind: PullKind;
  pullData: Hex;
  path: Hex; // Uniswap V3 packed path, "0x" when token == tokenOut
}

/** A leg before the payer signed it (what the solver outputs). */
export interface PlannedLeg {
  token: Address;
  amountIn: bigint;
  kind: PullKind;
  path: Hex;
  /** tokenOut expected from this leg at quote time (before slippage margin). */
  quotedOut: bigint;
}

export interface TokenBalance {
  token: Address;
  amount: bigint; // base units
}

export interface PayerPreferences {
  excludeTokens?: Address[];
  /** Slippage margin applied on amountIn, in basis points. Default 50. */
  maxSlippageBps?: number;
}

/** USD value of one whole unit of each currency (e.g. ARS -> 0.00068). */
export type ReferenceRates = Partial<Record<Currency, number>>;

export interface SolverInput {
  invoice: Pick<OnchainInvoice, "tokenOut" | "amountOut" | "deadline">;
  balances: TokenBalance[];
  prefs?: PayerPreferences;
  refRates: ReferenceRates;
}

/** Abstraction over Uniswap V3 QuoterV2 so the solver stays pure and testable. */
export interface QuoteSource {
  /** Input needed to receive exactly `amountOut` at the end of `path` (path encoded tokenIn -> tokenOut). */
  quoteExactOutput(path: Hex, amountOut: bigint): Promise<{ amountIn: bigint }>;
  /** Output received for exactly `amountIn` sent along `path` (tokenIn -> tokenOut). */
  quoteExactInput(path: Hex, amountIn: bigint): Promise<{ amountOut: bigint }>;
}

export interface PaymentPlan {
  legs: PlannedLeg[]; // 1..3
  tokenOut: Address;
  minOut: bigint; // == invoice.amountOut
  /** Total cost vs. reference rates, in basis points of output value. */
  costBps: number;
  /** Cost of the naive route (largest balance, direct path), in bps. null if naive route infeasible. */
  naiveCostBps: number | null;
  /** naiveCostBps - costBps, 0 if naive infeasible. */
  savingsBps: number;
  quotedAt: number; // unix ms
  expiresAt: number; // unix ms, quotedAt + 60s
}

export type SolveResult =
  | { ok: true; plan: PaymentPlan }
  | {
      ok: false;
      reason: "insufficient_balance" | "no_route" | "price_guard" | "over_cap";
      fallback: "direct_wfiat" | "ripio";
      detail?: string;
    };

export const InvoiceStatus = {
  open: "open",
  submitted: "submitted",
  paid: "paid",
  expired: "expired",
  cancelled: "cancelled",
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const SubmissionStatus = {
  pending: "pending", // written by web API, waiting for the relayer
  sending: "sending", // relayer picked it up, tx being built / broadcast
  sent: "sent", // tx broadcast, waiting for confirmation (indexer finalises)
  confirmed: "confirmed",
  failed: "failed",
} as const;
export type SubmissionStatus = (typeof SubmissionStatus)[keyof typeof SubmissionStatus];

/** Outbound notifications to merchants. Implemented by @cobra/bot (Telegram). */
export interface Notifier {
  invoicePaid(args: {
    merchantId: string;
    invoiceId: Hex;
    amountLocal: string;
    currency: Currency;
    reference: string | null;
    txHash: Hex;
  }): Promise<void>;
  text(merchantId: string, message: string): Promise<void>;
}
