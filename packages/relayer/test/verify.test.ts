import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWalletClient, encodeAbiParameters, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { permit2TypedData, PullKind, type Leg, type OnchainInvoice } from "@cobra/shared";
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

  async function check(payer: Address, signWith: typeof owner) {
    const nonce = 7n;
    const deadline = NOW + 300n;
    const base: Omit<Leg, "pullData"> = { token: TOKEN, amountIn: 1000n, kind: PullKind.PERMIT2, path: "0x" };
    const td = permit2TypedData({
      permit2: PERMIT2,
      chainId: foundry.id,
      token: TOKEN,
      amount: 1000n,
      router: ROUTER,
      nonce,
      deadline,
      invoice: inv,
      payer,
      legs: [base],
    });
    const signature: Hex = await signWith.signTypedData(td as never);
    const leg: Leg = {
      ...base,
      pullData: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }], [nonce, deadline, signature]),
    };
    return verifyLegs(
      { publicClient: a.publicClient, router: ROUTER, chainId: foundry.id, permit2: PERMIT2, nowSec: NOW },
      inv,
      payer,
      [leg],
    );
  }

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
});
