/**
 * Off-chain revalidation of a submission's legs (docs/interfaces.md §3), using the shared typed-data builders.
 * Every EIP-3009 / Permit2 signature must recover to the payer for THIS exact intent.
 */
import {
  concat,
  decodeAbiParameters,
  domainSeparator,
  hashStruct,
  isAddressEqual,
  keccak256,
  recoverAddress,
  recoverTypedDataAddress,
  serializeSignature,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  eip3009TypedData,
  intentDigest,
  legNonce,
  permit2TypedData,
  PullKind,
  tokenByAddress,
  type Leg,
  type OnchainInvoice,
} from "@cobra/shared";

const domainSeparatorAbi = [
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

export interface VerifyContext {
  publicClient: PublicClient;
  router: Address;
  chainId: number;
  permit2: Address;
  nowSec: bigint;
  /** Token EIP-712 domain; default shared TOKENS registry. Falls back to on-chain DOMAIN_SEPARATOR(). */
  tokenDomain?: (token: Address) => { name: string; version: string } | null | undefined;
  /** Seconds of validity a signature must still have when we send (default 30). */
  marginSec?: bigint;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

const domainCache = new Map<string, Hex>();

async function tokenDomainSeparator(ctx: VerifyContext, token: Address): Promise<Hex> {
  const d = (ctx.tokenDomain ?? ((t) => tokenByAddress(t)?.eip712))(token);
  if (d) return domainSeparator({ domain: { name: d.name, version: d.version, chainId: ctx.chainId, verifyingContract: token } });
  const key = `${ctx.chainId}:${token.toLowerCase()}`;
  const cached = domainCache.get(key);
  if (cached) return cached;
  const sep = await ctx.publicClient.readContract({ address: token, abi: domainSeparatorAbi, functionName: "DOMAIN_SEPARATOR" });
  domainCache.set(key, sep);
  return sep;
}

export async function verifyLegs(ctx: VerifyContext, inv: OnchainInvoice, payer: Address, legs: readonly Leg[]): Promise<VerifyResult> {
  if (legs.length < 1 || legs.length > 3) return { ok: false, reason: "invalid_legs" };
  const margin = ctx.marginSec ?? 30n;
  const digest = intentDigest(ctx.router, ctx.chainId, inv, payer, legs);

  for (const [i, leg] of legs.entries()) {
    if (leg.kind === PullKind.ALLOWANCE) return { ok: false, reason: `leg${i}:allowance_not_relayable` };

    if (leg.kind === PullKind.EIP3009) {
      let validAfter: bigint, validBefore: bigint, v: number, r: Hex, s: Hex;
      try {
        [validAfter, validBefore, v, r, s] = decodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
          leg.pullData,
        );
      } catch {
        return { ok: false, reason: `leg${i}:bad_pull_data` };
      }
      if (validBefore <= ctx.nowSec + margin) return { ok: false, reason: `leg${i}:authorization_expired` };
      if (validAfter > ctx.nowSec) return { ok: false, reason: `leg${i}:authorization_not_yet_valid` };
      const td = eip3009TypedData({
        token: leg.token,
        tokenDomain: { name: "", version: "" }, // domain handled below (registry or on-chain separator)
        chainId: ctx.chainId,
        from: payer,
        router: ctx.router,
        value: leg.amountIn,
        validAfter,
        validBefore,
        nonce: legNonce(digest, i),
      });
      let sep: Hex;
      try {
        sep = await tokenDomainSeparator(ctx, leg.token);
      } catch {
        return { ok: false, reason: `leg${i}:unknown_token_domain` };
      }
      const hash = keccak256(
        concat(["0x1901", sep, hashStruct({ data: td.message, primaryType: td.primaryType, types: td.types })]),
      );
      let signer: Address;
      try {
        signer = await recoverAddress({ hash, signature: serializeSignature({ r, s, v: BigInt(v) }) });
      } catch {
        return { ok: false, reason: `leg${i}:bad_signature` };
      }
      if (!isAddressEqual(signer, payer)) return { ok: false, reason: `leg${i}:signature_not_payer` };
      continue;
    }

    if (leg.kind === PullKind.PERMIT2) {
      let nonce: bigint, deadline: bigint, signature: Hex;
      try {
        [nonce, deadline, signature] = decodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
          leg.pullData,
        );
      } catch {
        return { ok: false, reason: `leg${i}:bad_pull_data` };
      }
      if (deadline <= ctx.nowSec + margin) return { ok: false, reason: `leg${i}:permit_expired` };
      const td = permit2TypedData({
        permit2: ctx.permit2,
        chainId: ctx.chainId,
        token: leg.token,
        amount: leg.amountIn,
        router: ctx.router,
        nonce,
        deadline,
        invoice: inv,
        payer,
        legs,
      });
      let signer: Address;
      try {
        signer = await recoverTypedDataAddress({ ...td, signature } as never);
      } catch {
        return { ok: false, reason: `leg${i}:bad_signature` };
      }
      if (!isAddressEqual(signer, payer)) return { ok: false, reason: `leg${i}:signature_not_payer` };
      continue;
    }

    return { ok: false, reason: `leg${i}:unknown_kind` };
  }
  return { ok: true };
}
