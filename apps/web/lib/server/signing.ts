/**
 * Per-leg typed data the payer signs (docs/interfaces.md §3). Built from the STORED quote both when
 * quoting (sent to the page) and when verifying a submission — the client's copy is never trusted.
 */
import { getAddress, type Address, type Hex } from "viem";
import {
  MAX_LEGS,
  decodePath,
  PullKind,
  eip3009TypedData,
  encodeEip3009PullData,
  encodePermit2PullData,
  intentDigest,
  legNonce,
  permit2TypedData,
  pullKindName,
  tokenByAddress,
  type Leg,
  type OnchainInvoice,
  type PlannedLeg,
} from "@cobra/shared";

export interface SigningContext {
  router: Address;
  chainId: number;
  permit2: Address;
  invoice: OnchainInvoice;
  payer: Address;
  legs: readonly PlannedLeg[];
}

/** EIP-3009 authorisations are valid from 0 until the invoice deadline (the router checks it too). */
export const EIP3009_VALID_AFTER = 0n;

export type LegSigning =
  | { kind: "EIP3009"; typedData: ReturnType<typeof eip3009TypedData>; validAfter: bigint; validBefore: bigint }
  | { kind: "PERMIT2"; typedData: ReturnType<typeof permit2TypedData>; nonce: bigint; deadline: bigint }
  | { kind: "ALLOWANCE"; typedData: null };

export class PlanValidationError extends Error {}

/** Defense in depth against a buggy solver: legs must be known tokens, supported kinds and well-formed paths. */
export function validatePlannedLegs(legs: readonly PlannedLeg[], tokenOut: Address): void {
  if (legs.length < 1 || legs.length > MAX_LEGS) throw new PlanValidationError(`bad leg count ${legs.length}`);
  legs.forEach((leg, i) => {
    const info = tokenByAddress(leg.token);
    if (!info) throw new PlanValidationError(`leg ${i}: unknown token ${leg.token}`);
    if (!info.pullKinds.includes(leg.kind)) throw new PlanValidationError(`leg ${i}: ${info.symbol} does not support ${pullKindName(leg.kind)}`);
    if (leg.kind === PullKind.EIP3009 && !info.eip712) throw new PlanValidationError(`leg ${i}: no EIP-712 domain for ${info.symbol}`);
    if (leg.amountIn <= 0n) throw new PlanValidationError(`leg ${i}: amountIn must be > 0`);
    if (getAddress(leg.token) === getAddress(tokenOut)) {
      if (leg.path !== "0x") throw new PlanValidationError(`leg ${i}: path must be empty when token == tokenOut`);
    } else {
      const { tokens } = decodePathSafe(leg.path, i);
      if (tokens[0] !== getAddress(leg.token) || tokens[tokens.length - 1] !== getAddress(tokenOut)) {
        throw new PlanValidationError(`leg ${i}: path must go from ${info.symbol} to tokenOut`);
      }
    }
  });
}

function decodePathSafe(path: Hex, i: number) {
  try {
    return decodePath(path);
  } catch {
    throw new PlanValidationError(`leg ${i}: invalid path`);
  }
}

export function buildLegSigning(ctx: SigningContext): LegSigning[] {
  const digest = intentDigest(ctx.router, ctx.chainId, ctx.invoice, ctx.payer, ctx.legs);
  return ctx.legs.map((leg, i): LegSigning => {
    const nonce = legNonce(digest, i);
    if (leg.kind === PullKind.EIP3009) {
      const info = tokenByAddress(leg.token);
      if (!info?.eip712) throw new PlanValidationError(`leg ${i}: no EIP-712 domain`);
      const validBefore = ctx.invoice.deadline;
      return {
        kind: "EIP3009",
        validAfter: EIP3009_VALID_AFTER,
        validBefore,
        typedData: eip3009TypedData({
          token: leg.token,
          tokenDomain: info.eip712,
          chainId: ctx.chainId,
          from: ctx.payer,
          router: ctx.router,
          value: leg.amountIn,
          validAfter: EIP3009_VALID_AFTER,
          validBefore,
          nonce,
        }),
      };
    }
    if (leg.kind === PullKind.PERMIT2) {
      const permitNonce = BigInt(nonce);
      const deadline = ctx.invoice.deadline;
      return {
        kind: "PERMIT2",
        nonce: permitNonce,
        deadline,
        typedData: permit2TypedData({
          permit2: ctx.permit2,
          chainId: ctx.chainId,
          token: leg.token,
          amount: leg.amountIn,
          router: ctx.router,
          nonce: permitNonce,
          deadline,
          invoice: ctx.invoice,
          payer: ctx.payer,
          legs: ctx.legs,
        }),
      };
    }
    return { kind: "ALLOWANCE", typedData: null };
  });
}

/** Signed on-chain legs (pullData encoded with the shared encoders). */
export function buildSignedLegs(legs: readonly PlannedLeg[], signing: readonly LegSigning[], signatures: readonly Hex[]): Leg[] {
  return legs.map((leg, i): Leg => {
    const s = signing[i]!;
    const sig = signatures[i]!;
    const pullData =
      s.kind === "EIP3009"
        ? encodeEip3009PullData(s.validAfter, s.validBefore, sig)
        : s.kind === "PERMIT2"
          ? encodePermit2PullData(s.nonce, s.deadline, sig)
          : "0x";
    return { token: leg.token, amountIn: leg.amountIn, kind: leg.kind, pullData, path: leg.path };
  });
}
