/**
 * CLI body of `pnpm verify:payments` (scripts/ops/verify-payments.ts). READ-ONLY.
 *   pnpm verify:payments               # one line per payment + usage summary
 *   pnpm verify:payments -- --markdown # the README "Usage" table on stdout
 *   pnpm verify:payments -- --readme   # rewrites that table in README.md, between the usage:start/end markers
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatUnits, getAddress, http, type PublicClient } from "viem";
import { celo } from "viem/chains";
import { explorerTx, tokenByAddress } from "@cobra/shared";
import { MAINNET_PROOF_DEFAULTS, collectPaymentProof, type ProofRow } from "./payment-proof";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function amountOf(r: { tokenOut: string; amountOut: bigint }): string {
  const t = tokenByAddress(r.tokenOut);
  return t ? `${formatUnits(r.amountOut, t.decimals)} ${t.symbol}` : `${r.amountOut} @ ${r.tokenOut}`;
}

export function usageSummary(rows: readonly ProofRow[]) {
  const real = rows.filter((r) => !r.team && r.status !== "FAIL");
  const distinct = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase())).size;
  return {
    payments: rows.length,
    teamTests: rows.filter((r) => r.team).length,
    realPayments: real.length,
    realMerchants: distinct(real.map((r) => r.merchant)),
    realPayers: distinct(real.map((r) => r.payer)),
  };
}

export function usageMarkdown(rows: readonly (ProofRow & { date: string })[]): string {
  const s = usageSummary(rows);
  const lines = [
    `**${s.realMerchants} merchants, ${s.realPayers} distinct payer wallets, ${s.realPayments} real payments** ` +
      `(plus ${s.teamTests} team test payments, not counted). Reproduce: \`pnpm verify:payments\`.`,
    "",
    "| Date (UTC) | Merchant | Received | Payer | Tx | Check | Kind |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.date} | \`${short(r.merchant)}\` | ${amountOf(r)} | \`${short(r.payer)}\` | [${r.txHash.slice(0, 10)}…](${explorerTx(r.txHash)}) | ${r.status} | ${r.team ? "team test" : "real"} |`,
    ),
  ];
  return lines.join("\n");
}

/** Replaces the text between the usage:start and usage:end markers (markers kept). */
export function replaceUsageBlock(readme: string, md: string): string {
  const m = /(<!-- usage:start[^\n]*-->\n)[\s\S]*?(<!-- usage:end -->)/.exec(readme);
  if (!m) throw new Error("README.md has no <!-- usage:start --> … <!-- usage:end --> markers");
  return readme.slice(0, m.index) + m[1] + md + "\n" + m[2] + readme.slice(m.index + m[0].length);
}

export async function runPaymentProofCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const pc = createPublicClient({ chain: celo, transport: http(process.env.RPC_URL || "https://forno.celo.org") }) as unknown as PublicClient;
  const agent = process.env.AGENT_ADDRESS ? getAddress(process.env.AGENT_ADDRESS) : MAINNET_PROOF_DEFAULTS.agent;
  const rows = await collectPaymentProof(pc, { agent, routers: MAINNET_PROOF_DEFAULTS.routers });
  const fails = rows.filter((r) => r.status === "FAIL").length;

  if (argv.includes("--markdown") || argv.includes("--readme")) {
    const dated = [];
    for (const r of rows) {
      const b = await pc.getBlock({ blockNumber: r.blockNumber });
      dated.push({ ...r, date: new Date(Number(b.timestamp) * 1000).toISOString().slice(0, 16).replace("T", " ") });
    }
    const md = usageMarkdown(dated);
    if (argv.includes("--readme")) {
      const path = fileURLToPath(new URL("../../../README.md", import.meta.url));
      writeFileSync(path, replaceUsageBlock(readFileSync(path, "utf8"), md));
      console.log(`README.md usage table updated: ${usageSummary(rows).realPayments} real payments, ${usageSummary(rows).teamTests} team tests`);
    } else console.log(md);
    return fails ? 1 : 0;
  }

  for (const r of rows) {
    const t = tokenByAddress(r.tokenOut);
    const refund = r.refunded > 0n && t ? `, refunded ${formatUnits(r.refunded, t.decimals)} ${t.symbol} to the payer` : "";
    console.log(
      `${r.status.padEnd(4)}  ${r.router}  block ${r.blockNumber}  ${amountOf(r).padEnd(16)}  ${r.team ? "team" : "REAL"}  ${explorerTx(r.txHash)}  ${r.detail}${refund}`,
    );
  }
  const s = usageSummary(rows);
  const n = (st: string) => rows.filter((r) => r.status === st).length;
  console.log(`\n${s.payments} payments: ${n("PASS")} PASS, ${n("WARN")} WARN, ${n("FAIL")} FAIL`);
  console.log(`team tests: ${s.teamTests} | real usage: ${s.realPayments} payments, ${s.realMerchants} merchants, ${s.realPayers} distinct payer wallets`);
  return fails ? 1 : 0;
}
