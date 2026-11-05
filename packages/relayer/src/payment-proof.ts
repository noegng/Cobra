/**
 * Payment-level proof, READ-ONLY (eth_getLogs, eth_getTransaction, eth_getTransactionReceipt). No key, no tx.
 * Finds every `Paid` event emitted by the Cobrá routers and checks, for each transaction: it succeeded, it called the
 * router, it was sent by the agent wallet (relayed), its calldata carries the ERC-8021 attribution code, and the
 * merchant received exactly the invoiced amount of tokenOut from the router (plus any surplus refunded to the payer).
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

/**
 * Wallets controlled by the Cobrá team. Payments where the payer or the merchant is one of them are labelled
 * "team test" and never counted as real usage. Add every wallet the team uses, before counting.
 */
export const TEAM_WALLETS: readonly Address[] = [
  "0x2891289891d6237614771363accb6327b56e18dc", // payer of validation payments 1, 3, 4 (2026-11-03/04)
  "0xba42b1c3f23c06b2ca65cc31a98dc9a80dcf85b7", // payer of validation payment 2 (Permit2, 2026-11-03)
  "0x22e6730f4943a30bab8a755cb11ed5d3ebe732a0", // merchant payout wallet of the 4 validation payments
];

export function isTeamWallet(a: string, team: readonly string[] = TEAM_WALLETS): boolean {
  return team.some((t) => t.toLowerCase() === a.toLowerCase());
}

const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

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
  payer: Address;
  /** Surplus of tokenOut sent back to the payer in the same tx (0n if none). */
  refunded: bigint;
  /** Payer or merchant is a team wallet. */
  team: boolean;
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

type ReceiptLog = { address: Address; topics: readonly Hex[]; data: Hex };

/** Sum of `token` Transfer amounts from `from` to `to` in a receipt. */
export function transferred(logs: readonly ReceiptLog[], token: Address, from: Address, to: Address): bigint {
  const word = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
  return logs
    .filter((l) => isAddressEqual(l.address, token) && l.topics[0] === transferTopic && l.topics[1]?.toLowerCase() === word(from) && l.topics[2]?.toLowerCase() === word(to))
    .reduce((s, l) => s + BigInt(l.data), 0n);
}

/** Pure verdict for one payment transaction. */
export function judgePaymentTx(
  tx: { from: Address; to: Address | null; input: Hex },
  receipt: { status: "success" | "reverted"; logs?: readonly ReceiptLog[] },
  o: { router: Address; agent: Address; code?: string; paid?: { merchant: Address; payer: Address; tokenOut: Address; amountOut: bigint } },
): Pick<ProofRow, "status" | "detail" | "refunded"> {
  const p: string[] = [];
  let refunded = 0n;
  if (receipt.status !== "success") p.push("reverted");
  if (!tx.to || !isAddressEqual(tx.to, o.router)) p.push(`called ${tx.to ?? "nothing"}, not the router`);
  if (!hasAttribution(tx.input, o.code)) p.push(`no ERC-8021 suffix with ${o.code ?? HACKATHON_ATTRIBUTION_CODE}`);
  if (o.paid && receipt.logs) {
    const got = transferred(receipt.logs, o.paid.tokenOut, o.router, o.paid.merchant);
    if (got !== o.paid.amountOut) p.push(`merchant received ${got}, Paid says ${o.paid.amountOut}`);
    refunded = transferred(receipt.logs, o.paid.tokenOut, o.router, o.paid.payer);
  }
  if (p.length) return { status: "FAIL", detail: p.join("; "), refunded };
  const exact = o.paid && receipt.logs ? ", merchant received the exact amount" : "";
  if (!isAddressEqual(tx.from, o.agent)) return { status: "WARN", detail: `tagged${exact}, but sent by ${tx.from} (payer fallback, not relayed)`, refunded };
  return { status: "PASS", detail: `relayed by the agent, ERC-8021 tagged${exact}`, refunded };
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
  o: { agent: Address; routers: readonly { label: string; address: Address; fromBlock: bigint }[]; code?: string; team?: readonly string[] },
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
      const paid = { merchant: log.args.merchant, payer: log.args.payer, tokenOut: log.args.tokenOut, amountOut: log.args.amountOut };
      rows.push({
        router: r.label,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        invoiceId: log.args.invoiceId,
        ...paid,
        team: isTeamWallet(paid.payer, o.team) || isTeamWallet(paid.merchant, o.team),
        ...judgePaymentTx(tx, rc, { router, agent: o.agent, code: o.code, paid }),
      });
    }
  }
  return rows.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
}
