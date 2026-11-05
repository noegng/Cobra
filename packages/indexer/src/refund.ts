/**
 * Real surplus refunded to the payer (WS15): sum of ERC-20 `Transfer(from = router, to = payer)` logs of `tokenOut`
 * in the payment's transaction. Bigint only. Any receipt problem yields null: the payment is still marked paid.
 */
import { pad, toEventSelector, type Address, type Hex, type PublicClient } from "viem";

const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const topicOf = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });

interface ReceiptLog {
  address: string;
  topics: readonly (Hex | null | undefined)[];
  data: Hex;
}

export function sumRefund(logs: readonly ReceiptLog[], tokenOut: Address, router: Address, payer: Address): bigint {
  const from = topicOf(router);
  const to = topicOf(payer);
  let total = 0n;
  for (const l of logs) {
    if (l.address.toLowerCase() !== tokenOut.toLowerCase()) continue;
    const t = l.topics;
    if (t.length !== 3 || t[0]?.toLowerCase() !== TRANSFER_TOPIC || t[1]?.toLowerCase() !== from || t[2]?.toLowerCase() !== to) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(l.data)) continue;
    total += BigInt(l.data);
  }
  return total;
}

/** null when the receipt cannot be read (RPC error, missing receipt, reverted tx). Never throws. */
export async function fetchRefundedOut(
  client: Pick<PublicClient, "getTransactionReceipt">,
  p: { txHash: Hex; tokenOut: Address; router: Address; payer: Address },
): Promise<bigint | null> {
  try {
    const r = await client.getTransactionReceipt({ hash: p.txHash });
    if (!r || r.status !== "success") return null;
    return sumRefund(r.logs, p.tokenOut, p.router, p.payer);
  } catch {
    return null;
  }
}
