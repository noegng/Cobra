/**
 * Wire format shared by the API and the page (no server-only imports here).
 * JSON cannot carry bigint: every integer is a decimal string on the wire and is re-hydrated
 * from the EIP-712 type schema before signing, so the wallet signs exactly what the server will verify.
 */
import type { Address, Hex } from "viem";
import type { SerializedPlan } from "@cobra/shared";

export type PullKindName = "EIP3009" | "PERMIT2" | "ALLOWANCE";

export interface WireTypedData {
  domain: { name?: string; version?: string; chainId: number; verifyingContract: Address };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  /** uint/int values are decimal strings. */
  message: Record<string, unknown>;
}

export interface ToSignEntry {
  index: number;
  kind: PullKindName;
  token: Address;
  symbol: string;
  decimals: number;
  amountIn: string;
  /** null for ALLOWANCE legs (the payer sends the tx themselves). */
  typedData: WireTypedData | null;
}

export interface WireOnchainInvoice {
  id: Hex;
  merchant: Address;
  tokenOut: Address;
  amountOut: string;
  deadline: string;
}

export interface PublicInvoice {
  id: Hex;
  merchantName: string;
  amountLocal: string;
  currency: string;
  reference: string | null;
  description: string | null;
  tokenOut: Address;
  tokenOutSymbol: string;
  tokenOutDecimals: number;
  amountOut: string;
  payoutAddress: Address;
  /** Effective status: an `open` invoice past its deadline is reported as `expired`. */
  status: string;
  expiresAt: string;
}

export interface QuoteOk {
  quoteId: string;
  quoteExpiresAt: string;
  plan: SerializedPlan;
  invoice: WireOnchainInvoice;
  router: Address;
  chainId: number;
  permit2: Address;
  /** Tokens of PERMIT2 legs whose Permit2 allowance is below amountIn (needs a one-time approve tx). */
  needsPermit2Approval: Address[];
  toSign: ToSignEntry[];
}

export interface DirectTransferFallback {
  address: Address;
  token: Address;
  symbol: string;
  amount: string; // base units
  decimals: number;
}

export interface QuoteError {
  error: string;
  message?: string;
  fallback?: "direct_wfiat" | "ripio";
  /** Ripio on-ramp link, only when a partner account is configured. */
  rampUrl?: string | null;
  directTransfer?: DirectTransferFallback;
}

export interface StatusResponse {
  status: string;
  submission: { status: string; txHash: Hex | null } | null;
  txHash: Hex | null;
  explorerUrl: string | null;
}

/** Recursively converts bigint to decimal string (JSON-safe). */
export function toWire<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => toWire(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toWire(v);
    return out;
  }
  return value;
}

const INT_RE = /^u?int(\d*)$/;

function hydrateValue(type: string, value: unknown, types: WireTypedData["types"]): unknown {
  if (type.endsWith("[]")) {
    const inner = type.slice(0, -2);
    if (!Array.isArray(value)) throw new Error(`expected array for ${type}`);
    return value.map((v) => hydrateValue(inner, v, types));
  }
  if (INT_RE.test(type)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") throw new Error(`bad int for ${type}`);
    return BigInt(value);
  }
  const struct = types[type];
  if (struct) return hydrateStruct(struct, value, types);
  return value;
}

function hydrateStruct(fields: readonly { name: string; type: string }[], value: unknown, types: WireTypedData["types"]) {
  if (!value || typeof value !== "object") throw new Error("expected struct");
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.name] = hydrateValue(f.type, src[f.name], types);
  return out;
}

/** Wire typed data -> viem/wagmi `signTypedData` arguments (integers as bigint). */
export function hydrateTypedData(td: WireTypedData) {
  const fields = td.types[td.primaryType];
  if (!fields) throw new Error(`unknown primaryType ${td.primaryType}`);
  return {
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: hydrateStruct(fields, td.message, td.types),
  };
}
