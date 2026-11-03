/**
 * Plan 3 / sub-agent B — merge b-t3.json, b-t10.json and the gas measurements into routes-bridge-gas.json.
 * Usage (repo root): pnpm exec tsx scripts/research/plan3/b-assemble.ts
 * Gas figures come from `forge test --match-path test/research/GasRoutes.t.sol -vv` (pasted below), price from `cast gas-price`.
 */
import { readFileSync, writeFileSync } from "node:fs";
const t3 = JSON.parse(readFileSync("docs/research/plan3/b-t3.json", "utf8"));
const t10 = JSON.parse(readFileSync("docs/research/plan3/b-t10.json", "utf8"));
const gasPriceWei = 202500000000n; // cast gas-price @ block 81825001
const celoUsdt = 0.073326; // QuoterV2 CELO->USDT fee 500, 1 CELO (73326 units of 6 dec); 100: 73129, 3000: 69086
const g = (name: string, route: string, gas: number, legs: number, hops: string, pull: string) => {
  const celo = Number(gasPriceWei * BigInt(gas)) / 1e18;
  return { name, route, legs, hops, pull, gasUsed: gas, gasPriceWei: gasPriceWei.toString(), costCelo: celo, costUsd: celo * celoUsdt };
};
const t11 = [
  g("1leg USDT->wARS EIP3009", "USDT-(100)->wARS", 363269, 1, "1", "EIP3009"),
  g("1leg USDT->wARS PERMIT2", "USDT-(100)->wARS", 372151, 1, "1", "PERMIT2"),
  g("1leg USDC->USDT->wARS EIP3009", "USDC-(100)->USDT-(100)->wARS", 468199, 1, "2", "EIP3009"),
  g("1leg USDC->USDT->wARS PERMIT2", "USDC-(100)->USDT-(100)->wARS", 473260, 1, "2", "PERMIT2"),
  g("2legs USDC(3009,2hops)+USDT(permit2,1hop)->wARS", "mixed", 632693, 2, "2+1", "EIP3009+PERMIT2"),
  g("2legs USDT(3009,1hop)+USAT(permit2,2hops)->wBRL", "mixed", 634216, 2, "1+2", "EIP3009+PERMIT2"),
  g("1leg wARS->wARS PERMIT2 no swap", "none", 182506, 1, "0", "PERMIT2"),
];
const ts = (await (await fetch("https://forno.celo.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x" + Number(t3.block).toString(16), false] }) })).json()).result;
writeFileSync("docs/research/plan3/routes-bridge-gas.json", JSON.stringify({
  generatedAt: new Date().toISOString(), chainId: 42220, block: t3.block, blockTimestamp: Number(t3.timestamp),
  notes: { gasBlock: 81825001, celoUsd: celoUsdt, celoUsdSource: "QuoterV2 quoteExactInput CELO->USDT fee 500, 1 CELO", spotMethod: "slot0 sqrtPriceX96 of each pool, product along path; USDT=USDC=USAT=1 USD; wFIAT USD value from USDT pool spot", t11Caveat: "gasleft delta around pay() on a fork; excludes 21000 intrinsic + calldata (~40-60k more); cold/warm state may differ from mainnet" },
  t3: { unitsPerUsd: t3.unitsPerUsd, unreachable: t3.unreachable, quotes: t3.results },
  t10: t10, t11,
}, null, 1));
// compact tables for the report
for (const r of t11) console.log(r.name, r.gasUsed, r.costCelo.toFixed(5), "CELO", r.costUsd.toFixed(5), "USD");
const best: Record<string, any> = {};
for (const q of t3.results) if (q.exactOutput.ok) { const k = q.pair + "|" + q.sizeUsd; if (!best[k] || q.exactOutput.costPct < best[k].exactOutput.costPct) best[k] = q; }
for (const q of Object.values<any>(best)) console.log(q.pair.padEnd(12), q.sizeUsd, q.path.padEnd(34), "cost", q.exactOutput.costPct.toFixed(3), "fee", q.exactOutput.feePct.toFixed(3), "impact", q.exactOutput.impactPct.toFixed(3), "in", q.exactOutput.amount);
void ts;
