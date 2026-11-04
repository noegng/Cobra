/**
 * Repro (anvil fork of Celo, local only): a 7702-delegated payer vs EIP-3009 (USDT/USDC) and Permit2.
 * anvil --fork-url https://forno.celo.org --port 8599 --chain-id 42220 &  then  RPC=http://127.0.0.1:8599 tsx scripts/repro-7702.ts
 * Uses anvil's public test key #0 only (delegated to a sweeper on Celo mainnet).
 */
import { createPublicClient, createTestClient, createWalletClient, http, keccak256, encodeAbiParameters, parseAbi, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TOKENS, eip3009TypedData } from "../src/index";

const RPC = process.env.RPC ?? "http://127.0.0.1:8599";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const acct = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const chain = { id: 42220, name: "celo", nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const wallet = createWalletClient({ chain, account: acct, transport: http(RPC) });
const RECEIVER = "0x000000000000000000000000000000000000dEaD" as Address;
const abi3009 = parseAbi(["function receiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)"]);
const p2abi = parseAbi([
  "function permitTransferFrom(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount) transferDetails,address owner,bytes signature)",
]);

async function fund(token: Address, slot: bigint) {
  const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [acct.address, slot]));
  await test.setStorageAt({ address: token, index: key, value: ("0x" + (10n ** 9n).toString(16).padStart(64, "0")) as Hex });
}
async function attempt(label: string, to: Address, data: Hex) {
  await test.impersonateAccount({ address: to });
  await test.setBalance({ address: to, value: 10n ** 18n });
  try {
    await pub.call({ account: to, to: (label.startsWith("PERMIT2") ? PERMIT2 : TARGET[label]) , data });
    console.log(label, "OK");
  } catch (e) {
    console.log(label, "REVERT:", (e as Error).message.split("\n").find((l) => /revert|Error|invalid/i.test(l))?.trim());
  }
}
const TARGET: Record<string, Address> = {};

for (const mode of ["delegated", "plain"] as const) {
  if (mode === "plain") await test.setCode({ address: acct.address, bytecode: "0x" });
  console.log(`== payer ${acct.address} code=${(await pub.getCode({ address: acct.address }))?.slice(0, 12)} (${mode})`);
  const router = "0x00000000000000000000000000000000000c0b4a" as Address;
  for (const sym of ["USDT", "USDC"] as const) {
    const t = TOKENS.find((x) => x.symbol === sym)!;
    await fund(t.address, sym === "USDC" ? 9n : 51n);
    const nonce = keccak256("0x1234");
    const td = eip3009TypedData({ token: t.address, tokenDomain: t.eip712!, chainId: 42220, from: acct.address, router, value: 1_000_000n, validAfter: 0n, validBefore: 2n ** 40n, nonce });
    const sig = await acct.signTypedData(td);
    const r = sig.slice(0, 66) as Hex, s = ("0x" + sig.slice(66, 130)) as Hex, v = parseInt(sig.slice(130, 132), 16);
    const { encodeFunctionData } = await import("viem");
    const data = encodeFunctionData({ abi: abi3009, functionName: "receiveWithAuthorization", args: [acct.address, router, 1_000_000n, 0n, 2n ** 40n, nonce, v, r, s] });
    TARGET[`EIP3009 ${sym}`] = t.address;
    await attempt(`EIP3009 ${sym}`, router, data);
    // Permit2 (plain permitTransferFrom: same SignatureVerification as the witness variant)
    await test.impersonateAccount({ address: acct.address });
    const erc = parseAbi(["function approve(address,uint256) returns (bool)"]);
    await test.setBalance({ address: acct.address, value: 10n ** 18n });
    try {
      await pub.simulateContract({ account: acct.address, address: t.address, abi: erc, functionName: "approve", args: [PERMIT2, 2n ** 256n - 1n] });
    } catch {}
    // set allowance(payer, permit2) directly is token-specific; use impersonated approve tx
    await test.impersonateAccount({ address: acct.address });
    const h = await test.sendUnsignedTransaction({ from: acct.address, to: t.address, data: encodeFunctionData({ abi: erc, functionName: "approve", args: [PERMIT2, 2n ** 256n - 1n] }) }).catch((e: Error) => e.message.slice(0, 80));
    void h;
    const p2td = { domain: { name: "Permit2", chainId: 42220, verifyingContract: PERMIT2 }, types: { PermitTransferFrom: [{ name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }], TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] }, primaryType: "PermitTransferFrom", message: { permitted: { token: t.address, amount: 1_000_000n }, spender: router, nonce: 7n, deadline: 2n ** 40n } } as const;
    const sig2 = await acct.signTypedData(p2td);
    const d2 = encodeFunctionData({ abi: p2abi, functionName: "permitTransferFrom", args: [{ permitted: { token: t.address, amount: 1_000_000n }, nonce: 7n, deadline: 2n ** 40n }, { to: RECEIVER, requestedAmount: 1_000_000n }, acct.address, sig2] });
    await attempt(`PERMIT2 ${sym}`, router, d2);
  }
}
void wallet;
