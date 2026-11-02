/**
 * FROZEN signing scheme (WS0). See docs/interfaces.md §3.
 *
 * Every pull signature commits to the full PaymentIntent (invoice + payer + leg commitments):
 *  - EIP-3009: the authorization nonce is derived from the intent digest and the leg index,
 *              the router recomputes it, so a signature only works for that exact intent.
 *  - Permit2:  permitWitnessTransferFrom with witness = hashStruct(PaymentIntent).
 *  - Allowance: no signature, the router requires msg.sender == payer.
 */
import {
  encodeAbiParameters,
  hashStruct,
  hashTypedData,
  keccak256,
  parseSignature,
  toHex,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import type { Leg, OnchainInvoice, PlannedLeg } from "./types";
import { PullKind } from "./types";

export const ROUTER_DOMAIN = { name: "Cobra Router", version: "1" } as const;

export const intentTypes = {
  Invoice: [
    { name: "id", type: "bytes32" },
    { name: "merchant", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountOut", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  LegCommitment: [
    { name: "token", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "kind", type: "uint8" },
    { name: "pathHash", type: "bytes32" },
  ],
  PaymentIntent: [
    { name: "invoice", type: "Invoice" },
    { name: "payer", type: "address" },
    { name: "legs", type: "LegCommitment[]" },
  ],
} as const;

/** EIP-712 encodeType strings, exported so Solidity tests can compare typehashes. */
export const TYPE_STRINGS = {
  Invoice: "Invoice(bytes32 id,address merchant,address tokenOut,uint256 amountOut,uint256 deadline)",
  LegCommitment: "LegCommitment(address token,uint256 amountIn,uint8 kind,bytes32 pathHash)",
  PaymentIntent:
    "PaymentIntent(Invoice invoice,address payer,LegCommitment[] legs)" +
    "Invoice(bytes32 id,address merchant,address tokenOut,uint256 amountOut,uint256 deadline)" +
    "LegCommitment(address token,uint256 amountIn,uint8 kind,bytes32 pathHash)",
  /** Passed verbatim to Permit2.permitWitnessTransferFrom. */
  PERMIT2_WITNESS:
    "PaymentIntent witness)" +
    "Invoice(bytes32 id,address merchant,address tokenOut,uint256 amountOut,uint256 deadline)" +
    "LegCommitment(address token,uint256 amountIn,uint8 kind,bytes32 pathHash)" +
    "PaymentIntent(Invoice invoice,address payer,LegCommitment[] legs)" +
    "TokenPermissions(address token,uint256 amount)",
  ReceiveWithAuthorization:
    "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
} as const;

type LegLike = Pick<Leg | PlannedLeg, "token" | "amountIn" | "kind" | "path">;

export function legCommitment(leg: LegLike) {
  return { token: leg.token, amountIn: leg.amountIn, kind: leg.kind, pathHash: keccak256(leg.path) };
}

function intentMessage(inv: OnchainInvoice, payer: Address, legs: readonly LegLike[]) {
  return { invoice: inv, payer, legs: legs.map(legCommitment) };
}

export function routerDomain(router: Address, chainId: number): TypedDataDomain {
  return { ...ROUTER_DOMAIN, chainId, verifyingContract: router };
}

/** Key of the router's `isPaid` mapping. */
export function hashInvoice(inv: OnchainInvoice): Hex {
  return hashStruct({ data: inv, primaryType: "Invoice", types: intentTypes });
}

/** hashStruct(PaymentIntent) — the Permit2 witness. */
export function hashIntent(inv: OnchainInvoice, payer: Address, legs: readonly LegLike[]): Hex {
  return hashStruct({ data: intentMessage(inv, payer, legs), primaryType: "PaymentIntent", types: intentTypes });
}

/** Full EIP-712 digest under the router domain — the seed of EIP-3009 nonces. */
export function intentDigest(
  router: Address,
  chainId: number,
  inv: OnchainInvoice,
  payer: Address,
  legs: readonly LegLike[],
): Hex {
  return hashTypedData({
    domain: routerDomain(router, chainId),
    types: intentTypes,
    primaryType: "PaymentIntent",
    message: intentMessage(inv, payer, legs),
  });
}

/** nonce = keccak256(abi.encode(intentDigest, legIndex)). Used for EIP-3009 (bytes32) and Permit2 (uint256). */
export function legNonce(digest: Hex, legIndex: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [digest, BigInt(legIndex)]));
}

/** Typed data the payer signs for an EIP-3009 leg (`receiveWithAuthorization`, to = router). */
export function eip3009TypedData(args: {
  token: Address;
  tokenDomain: { name: string; version: string };
  chainId: number;
  from: Address;
  router: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}) {
  return {
    domain: { ...args.tokenDomain, chainId: args.chainId, verifyingContract: args.token },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: args.from,
      to: args.router,
      value: args.value,
      validAfter: args.validAfter,
      validBefore: args.validBefore,
      nonce: args.nonce,
    },
  } as const;
}

/** Typed data the payer signs for a Permit2 leg (`permitWitnessTransferFrom`, spender = router). */
export function permit2TypedData(args: {
  permit2: Address;
  chainId: number;
  token: Address;
  amount: bigint;
  router: Address;
  nonce: bigint;
  deadline: bigint;
  invoice: OnchainInvoice;
  payer: Address;
  legs: readonly LegLike[];
}) {
  return {
    domain: { name: "Permit2", chainId: args.chainId, verifyingContract: args.permit2 },
    types: {
      PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "PaymentIntent" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      ...intentTypes,
    },
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: args.token, amount: args.amount },
      spender: args.router,
      nonce: args.nonce,
      deadline: args.deadline,
      witness: intentMessage(args.invoice, args.payer, args.legs),
    },
  } as const;
}

/** pullData for EIP-3009: abi.encode(uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s). */
export function encodeEip3009PullData(validAfter: bigint, validBefore: bigint, signature: Hex): Hex {
  const sig = parseSignature(signature);
  const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0);
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
    [validAfter, validBefore, v, sig.r, sig.s],
  );
}

/** pullData for Permit2: abi.encode(uint256 nonce, uint256 deadline, bytes signature). */
export function encodePermit2PullData(nonce: bigint, deadline: bigint, signature: Hex): Hex {
  return encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }], [nonce, deadline, signature]);
}

/** pullData for ALLOWANCE legs is empty. */
export const ALLOWANCE_PULL_DATA: Hex = "0x";

export function pullKindName(kind: PullKind): "EIP3009" | "PERMIT2" | "ALLOWANCE" {
  return kind === PullKind.EIP3009 ? "EIP3009" : kind === PullKind.PERMIT2 ? "PERMIT2" : "ALLOWANCE";
}

/** Random bytes32 invoice id (crypto-secure). */
export function randomInvoiceId(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
