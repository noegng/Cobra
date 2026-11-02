import { describe, expect, it } from "vitest";
import {
  concatHex,
  getAddress,
  encodeAbiParameters,
  hashStruct,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import {
  PullKind,
  TYPE_STRINGS,
  encodePath,
  decodePath,
  reversePath,
  hashIntent,
  hashInvoice,
  intentDigest,
  intentTypes,
  legNonce,
  permit2TypedData,
  eip3009TypedData,
  encodeEip3009PullData,
  toBaseUnits,
  fromBaseUnits,
  type OnchainInvoice,
} from "../src/index";

// anvil default account #0 — public test key, never funded on mainnet
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const payer = privateKeyToAccount(TEST_KEY);
const ROUTER = "0x00000000000000000000000000000000c0b4a000" as Address;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const A = "0x000000000000000000000000000000000000a001" as Address;
const OUT = "0x000000000000000000000000000000000000f003" as Address;

const inv: OnchainInvoice = {
  id: keccak256(toHex("inv")),
  merchant: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  tokenOut: OUT,
  amountOut: 10n ** 18n,
  deadline: 1_800_000_000n,
};
const legs = [{ token: A, amountIn: 1_000_000n, kind: PullKind.PERMIT2, path: encodePath([A, OUT], [500]) }];

const th = (s: string) => keccak256(toHex(s));

describe("EIP-712 type strings match viem's encoding", () => {
  it("Invoice", () => {
    const manual = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
        [th(TYPE_STRINGS.Invoice), inv.id, inv.merchant, inv.tokenOut, inv.amountOut, inv.deadline],
      ),
    );
    expect(hashInvoice(inv)).toBe(manual);
  });

  it("PaymentIntent (array of structs = keccak of concatenated struct hashes)", () => {
    const legHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32" }],
        [th(TYPE_STRINGS.LegCommitment), legs[0]!.token, legs[0]!.amountIn, legs[0]!.kind, keccak256(legs[0]!.path)],
      ),
    );
    const manual = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
        [th(TYPE_STRINGS.PaymentIntent), hashInvoice(inv), payer.address, keccak256(concatHex([legHash]))],
      ),
    );
    expect(hashIntent(inv, payer.address, legs)).toBe(manual);
  });

  it("Permit2 witness type string reproduces the wallet-side typehash", () => {
    const td = permit2TypedData({
      permit2: PERMIT2, chainId: 42220, token: A, amount: 1_000_000n, router: ROUTER,
      nonce: 7n, deadline: 1_800_000_000n, invoice: inv, payer: payer.address, legs,
    });
    // What Permit2's SignatureTransfer computes on-chain:
    const permit2Typehash = th(
      "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline," +
        TYPE_STRINGS.PERMIT2_WITNESS,
    );
    const tokenPermHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
        [th("TokenPermissions(address token,uint256 amount)"), A, 1_000_000n],
      ),
    );
    const onchain = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
        [permit2Typehash, tokenPermHash, ROUTER, 7n, 1_800_000_000n, hashIntent(inv, payer.address, legs)],
      ),
    );
    const walletSide = hashStruct({ data: td.message, primaryType: td.primaryType, types: td.types });
    expect(walletSide).toBe(onchain);
  });

  it("intentDigest changes with router / chain / any leg field", () => {
    const d = intentDigest(ROUTER, 42220, inv, payer.address, legs);
    expect(intentDigest(A, 42220, inv, payer.address, legs)).not.toBe(d);
    expect(intentDigest(ROUTER, 44787, inv, payer.address, legs)).not.toBe(d);
    expect(intentDigest(ROUTER, 42220, inv, payer.address, [{ ...legs[0]!, amountIn: 1n }])).not.toBe(d);
    expect(intentDigest(ROUTER, 42220, { ...inv, amountOut: 1n }, payer.address, legs)).not.toBe(d);
    expect(legNonce(d, 0)).not.toBe(legNonce(d, 1));
  });
});

describe("signatures round-trip", () => {
  it("EIP-3009 typed data signs and recovers, pullData encodes", async () => {
    const nonce = legNonce(intentDigest(ROUTER, 42220, inv, payer.address, legs), 0);
    const td = eip3009TypedData({
      token: A, tokenDomain: { name: "USDC", version: "2" }, chainId: 42220, from: payer.address,
      router: ROUTER, value: 1_000_000n, validAfter: 0n, validBefore: inv.deadline, nonce,
    });
    const sig = await payer.signTypedData(td);
    expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(payer.address);
    const pd = encodeEip3009PullData(0n, inv.deadline, sig);
    expect((pd.length - 2) / 2).toBe(5 * 32);
  });

  it("Permit2 typed data signs and recovers", async () => {
    const td = permit2TypedData({
      permit2: PERMIT2, chainId: 42220, token: A, amount: 1_000_000n, router: ROUTER,
      nonce: 1n, deadline: inv.deadline, invoice: inv, payer: payer.address, legs,
    });
    const sig = await payer.signTypedData(td);
    expect(await recoverTypedDataAddress({ ...td, signature: sig as Hex })).toBe(payer.address);
  });
});

describe("paths & amounts", () => {
  it("encode/decode/reverse path", () => {
    const B = "0x000000000000000000000000000000000000b002" as Address;
    const p = encodePath([A, B, OUT], [100, 500]);
    expect(decodePath(p)).toEqual({ tokens: [A, B, OUT].map((x) => getAddress(x)), fees: [100, 500] });
    expect(decodePath(reversePath(p))).toEqual({ tokens: [OUT, B, A].map((x) => getAddress(x)), fees: [500, 100] });
  });
  it("base units are exact", () => {
    expect(toBaseUnits("4500.5", 18)).toBe(4500500000000000000000n);
    expect(fromBaseUnits(4500500000000000000000n, 18)).toBe("4500.5");
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
    expect(() => toBaseUnits("1.0000001", 6)).toThrow();
  });
  it("intentTypes stays in sync with TYPE_STRINGS field order", () => {
    const enc = (name: keyof typeof intentTypes) =>
      `${name}(${intentTypes[name].map((f) => `${f.type} ${f.name}`).join(",")})`;
    expect(TYPE_STRINGS.Invoice).toBe(enc("Invoice"));
    expect(TYPE_STRINGS.LegCommitment).toBe(enc("LegCommitment"));
    expect(TYPE_STRINGS.PaymentIntent.startsWith(enc("PaymentIntent"))).toBe(true);
  });
});
