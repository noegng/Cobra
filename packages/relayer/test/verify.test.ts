import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWalletClient, encodeAbiParameters, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { TEXTILE_VENUE_MAGIC, encodeTextileVenue, permit2TypedData, PullKind, type Leg, type OnchainInvoice } from "@cobra/shared";
import { verifyLegs } from "../src/verify";
import { ANVIL_KEYS, hasAnvil, startAnvil, type Anvil } from "./helpers";
import { MOCK_1271_WALLET_BYTECODE } from "./fixtures/mocks";

const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ROUTER: Address = "0x00000000000000000000000000000000000000a1";
const TOKEN: Address = "0x00000000000000000000000000000000000000b2";
const NOW = 1_800_000_000n;

describe.skipIf(!hasAnvil)("verifyLegs: ERC-1271 aware signature checks", () => {
  let a: Anvil;
  beforeEach(async () => {
    a = await startAnvil();
  });
  afterEach(async () => {
    await a.stop();
  });

  const owner = privateKeyToAccount(ANVIL_KEYS.payer);
  const other = privateKeyToAccount(ANVIL_KEYS.other);
  const inv: OnchainInvoice = {
    id: `0x${"11".repeat(32)}`,
    merchant: "0x00000000000000000000000000000000000000c3",
    tokenOut: "0x00000000000000000000000000000000000000d4",
    amountOut: 1000n,
    deadline: NOW + 600n,
  };

  async function check(payer: Address, signWith: typeof owner, path: Hex = "0x", extra: { allowTextile?: boolean; tokenOut?: Address } = {}) {
    const nonce = 7n;
    const deadline = NOW + 300n;
    const base: Omit<Leg, "pullData"> = { token: TOKEN, amountIn: 1000n, kind: PullKind.PERMIT2, path };
    const invoice = extra.tokenOut ? { ...inv, tokenOut: extra.tokenOut } : inv;
    const td = permit2TypedData({
      permit2: PERMIT2,
      chainId: foundry.id,
      token: TOKEN,
      amount: 1000n,
      router: ROUTER,
      nonce,
      deadline,
      invoice,
      payer,
      legs: [base],
    });
    const signature: Hex = await signWith.signTypedData(td as never);
    const leg: Leg = {
      ...base,
      pullData: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }], [nonce, deadline, signature]),
    };
    return verifyLegs(
      { publicClient: a.publicClient, router: ROUTER, chainId: foundry.id, permit2: PERMIT2, nowSec: NOW, ...(extra.allowTextile !== undefined && { allowTextile: extra.allowTextile }) },
      invoice,
      payer,
      [leg],
    );
  }

  it("WS7-7: zero amountOut or zero amountIn is rejected before any signature work", async () => {
    const ctx = { publicClient: a.publicClient, router: ROUTER, chainId: foundry.id, permit2: PERMIT2, nowSec: NOW };
    const leg: Leg = { token: TOKEN, amountIn: 0n, kind: PullKind.PERMIT2, path: "0x", pullData: "0x" };
    expect(await verifyLegs(ctx, inv, owner.address, [leg])).toEqual({ ok: false, reason: "leg0:zero_amount_in" });
    expect(await verifyLegs(ctx, { ...inv, amountOut: 0n }, owner.address, [{ ...leg, amountIn: 1n }])).toEqual({ ok: false, reason: "zero_amount_out" });
  });

  it("EOA signature accepted", async () => {
    expect(await check(owner.address, owner)).toEqual({ ok: true });
  });

  it("wrong signer rejected", async () => {
    expect(await check(owner.address, other)).toEqual({ ok: false, reason: "leg0:signature_not_payer" });
  });

  it("ERC-1271 contract wallet accepted, and rejected when its owner did not sign", async () => {
    const wallet = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS.deployer), chain: foundry, transport: http(a.url) });
    const hash = await wallet.deployContract({
      abi: parseAbi(["constructor(address owner)"]),
      bytecode: MOCK_1271_WALLET_BYTECODE,
      args: [owner.address],
    });
    const { contractAddress } = await a.publicClient.waitForTransactionReceipt({ hash });
    const smart = getAddress(contractAddress!);
    expect(await check(smart, owner)).toEqual({ ok: true });
    expect(await check(smart, other)).toEqual({ ok: false, reason: "leg0:signature_not_payer" });
  });

  describe("Textile RFQ legs (router v2)", () => {
    const path = encodeTextileVenue([{ order: "0xabcd", sig: "0x1234" }]);

    it("well-formed Textile path with a valid payer signature over keccak256(path) is accepted", async () => {
      expect(await check(owner.address, owner, path)).toEqual({ ok: true });
    });

    it("a signature made for a different path (orders swapped after signing) is rejected", async () => {
      // the payer signed `path`; the relayer is handed other orders -> digest differs -> signature_not_payer
      const nonce = 7n;
      const deadline = NOW + 300n;
      const signedLeg: Omit<Leg, "pullData"> = { token: TOKEN, amountIn: 1000n, kind: PullKind.PERMIT2, path };
      const td = permit2TypedData({ permit2: PERMIT2, chainId: foundry.id, token: TOKEN, amount: 1000n, router: ROUTER, nonce, deadline, invoice: inv, payer: owner.address, legs: [signedLeg] });
      const sig: Hex = await owner.signTypedData(td as never);
      const tampered: Leg = {
        ...signedLeg,
        path: encodeTextileVenue([{ order: "0xdead", sig: "0x1234" }]),
        pullData: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }], [nonce, deadline, sig]),
      };
      const res = await verifyLegs({ publicClient: a.publicClient, router: ROUTER, chainId: foundry.id, permit2: PERMIT2, nowSec: NOW }, inv, owner.address, [tampered]);
      expect(res).toEqual({ ok: false, reason: "leg0:signature_not_payer" });
    });

    it("malformed Textile path (magic, garbage body) is rejected", async () => {
      expect(await check(owner.address, owner, `${TEXTILE_VENUE_MAGIC}deadbeef`)).toEqual({ ok: false, reason: "leg0:bad_textile_path" });
    });

    it("Textile path is refused when the configured router is v1", async () => {
      expect(await check(owner.address, owner, path, { allowTextile: false })).toEqual({ ok: false, reason: "leg0:textile_not_enabled" });
    });

    it("Textile leg whose token is tokenOut is refused", async () => {
      expect(await check(owner.address, owner, path, { tokenOut: TOKEN })).toEqual({ ok: false, reason: "leg0:textile_bad_token" });
    });
  });
});
