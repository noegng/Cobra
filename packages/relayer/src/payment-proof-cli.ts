/** CLI body of `pnpm verify:payments` (scripts/ops/verify-payments.ts). READ-ONLY. */
import { createPublicClient, formatUnits, getAddress, http, type PublicClient } from "viem";
import { celo } from "viem/chains";
import { tokenByAddress } from "@cobra/shared";
import { MAINNET_PROOF_DEFAULTS, collectPaymentProof } from "./payment-proof";

export async function runPaymentProofCli(): Promise<number> {
  const pc = createPublicClient({ chain: celo, transport: http(process.env.RPC_URL || "https://forno.celo.org") }) as unknown as PublicClient;
  const agent = process.env.AGENT_ADDRESS ? getAddress(process.env.AGENT_ADDRESS) : MAINNET_PROOF_DEFAULTS.agent;
  const rows = await collectPaymentProof(pc, { agent, routers: MAINNET_PROOF_DEFAULTS.routers });
  for (const r of rows) {
    const t = tokenByAddress(r.tokenOut);
    const amount = t ? `${formatUnits(r.amountOut, t.decimals)} ${t.symbol}` : `${r.amountOut} @ ${r.tokenOut}`;
    console.log(`${r.status.padEnd(4)}  ${r.router}  block ${r.blockNumber}  ${amount.padEnd(16)}  https://celoscan.io/tx/${r.txHash}  ${r.detail}`);
  }
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  const merchants = new Set(rows.map((r) => r.merchant.toLowerCase())).size;
  console.log(`\n${rows.length} payments, ${merchants} distinct merchant wallets: ${n("PASS")} PASS, ${n("WARN")} WARN, ${n("FAIL")} FAIL`);
  return n("FAIL") ? 1 : 0;
}
