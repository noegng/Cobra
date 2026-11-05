/**
 * Payment-level proof, READ-ONLY (eth_getLogs, eth_getTransaction, eth_getTransactionReceipt). No key, no tx.
 * Finds every `Paid` event emitted by the Cobrá routers and checks, for each transaction: it succeeded, it called the
 * router, it was sent by the agent wallet (relayed) and its calldata carries the ERC-8021 attribution code.
 * Entry: scripts/ops/verify-payments.ts (`pnpm verify:payments`).
 */
import { fromDataSuffix } from "@celo/attribution-tags";
import { getAddress, isAddressEqual, parseAbiItem, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { HACKATHON_ATTRIBUTION_CODE } from "@cobra/shared";

/** Public mainnet deployment, as listed in the README ("Deployed addresses and proof transactions"). */
export const MAINNET_PROOF_DEFAULTS = {
  agent: "0x9E828B877EFCdb79B507fF6234d841A8265Cccd5" as Address,
  routers: [
    { label: "v1", address: "0xfe38683105fa36ee664acefe7e714ba93492e458" as Address, fromBlock: 81818614n },
    { label: "v2", address: "0x5658505fc0632269e024893a7448a3b5070d7069" as Address, fromBlock: 81913649n },
  ],
} as const;

const paidEvent = parseAbiItem(
  "event Paid(bytes32 indexed invoiceId, address indexed payer, address indexed merchant, address tokenOut, uint256 amountOut)",
);

export interface ProofRow {
  router: string;
  txHash: Hash;
  blockNumber: bigint;
  invoiceId: Hex;
  merchant: Address;
  tokenOut: Address;
  amountOut: bigint;
  /** PASS: relayed by the agent and tagged. WARN: tagged but sent by the payer (fallback mode). FAIL otherwise. */
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
}

/** True when `input` ends with an ERC-8021 data suffix that contains `code`. */
export function hasAttribution(input: Hex, code: string = HACKATHON_ATTRIBUTION_CODE): boolean {
  try {
    return JSON.stringify(fromDataSuffix(input)).includes(code);
  } catch {
    return false;
  }
}

/** Pure verdict for one payment transaction. */
export function judgePaymentTx(
  tx: { from: Address; to: Address | null; input: Hex },
  receipt: { status: "success" | "reverted" },
  o: { router: Address; agent: Address; code?: string },
): Pick<ProofRow, "status" | "detail"> {
  const p: string[] = [];
  if (receipt.status !== "success") p.push("reverted");
  if (!tx.to || !isAddressEqual(tx.to, o.router)) p.push(`called ${tx.to ?? "nothing"}, not the router`);
  if (!hasAttribution(tx.input, o.code)) p.push(`no ERC-8021 suffix with ${o.code ?? HACKATHON_ATTRIBUTION_CODE}`);
  if (p.length) return { status: "FAIL", detail: p.join("; ") };
  if (!isAddressEqual(tx.from, o.agent)) return { status: "WARN", detail: `tagged, but sent by ${tx.from} (payer fallback, not relayed)` };
  return { status: "PASS", detail: "relayed by the agent, ERC-8021 tagged" };
}

/** Paid logs of one router over [fromBlock, toBlock], halving the range when the RPC refuses it. */
export async function paidLogs(pc: PublicClient, router: Address, fromBlock: bigint, toBlock: bigint, step = 50_000n) {
  const out = [];
  let from = fromBlock;
  let size = step;
  while (from <= toBlock) {
    const to = from + size - 1n < toBlock ? from + size - 1n : toBlock;
    try {
      out.push(...(await pc.getLogs({ address: router, event: paidEvent, fromBlock: from, toBlock: to, strict: true })));
      from = to + 1n;
    } catch (e) {
      if (size <= 500n) throw e;
      size /= 2n;
    }
  }
  return out;
}

export async function collectPaymentProof(
  pc: PublicClient,
  o: { agent: Address; routers: readonly { label: string; address: Address; fromBlock: bigint }[]; code?: string },
): Promise<ProofRow[]> {
  const latest = await pc.getBlockNumber();
  const rows: ProofRow[] = [];
  for (const r of o.routers) {
    const router = getAddress(r.address);
    for (const log of await paidLogs(pc, router, r.fromBlock, latest)) {
      const [tx, rc] = await Promise.all([
        pc.getTransaction({ hash: log.transactionHash }),
        pc.getTransactionReceipt({ hash: log.transactionHash }),
      ]);
      rows.push({
        router: r.label,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        invoiceId: log.args.invoiceId,
        merchant: log.args.merchant,
        tokenOut: log.args.tokenOut,
        amountOut: log.args.amountOut,
        ...judgePaymentTx(tx, rc, { router, agent: o.agent, code: o.code }),
      });
    }
  }
  return rows.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
}
