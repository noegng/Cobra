/**
 * Read-only smoke test of the production solver against Celo mainnet (QuoterV2 eth_call + live FX rates).
 * Fake payer balances, no wallet, no transaction. Same options as apps/web (capUsd 200, feeTiers [100]).
 *   pnpm exec tsx scripts/ops/solve-smoke.ts
 */
import { createPublicClient, http, parseUnits } from "viem";
import { celo } from "viem/chains";
import { CELO, TOKENS, tokenBySymbol } from "../../packages/shared/src/index";
import { createReferenceRateSource, createUniswapQuoter, solve } from "../../packages/solver/src/index";

const client = createPublicClient({ chain: celo, transport: http(process.env.RPC_URL || "https://forno.celo.org"), batch: { multicall: true } });
const quoter = createUniswapQuoter(client as Parameters<typeof createUniswapQuoter>[0], CELO.uniswapV3.quoterV2.address);
const refRates = await createReferenceRateSource()();
const T = (s: string) => tokenBySymbol(s)!;
const sym = (a: string) => TOKENS.find((t) => t.address.toLowerCase() === a.toLowerCase())?.symbol ?? a;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);

const cases: [string, string, string, [string, string][]][] = [
  ["wARS 15000 / 50 USDT", "wARS", "15000", [["USDT", "50"]]],
  ["wARS 15000 / 50 USDC (2 hops)", "wARS", "15000", [["USDC", "50"]]],
  ["wARS 15000 / 5 USDT + 5 USDC + 5 USAT (split)", "wARS", "15000", [["USDT", "5"], ["USDC", "5"], ["USAT", "5"]]],
  ["wARS 320000 (~193 USD, under cap) / 500 USDT", "wARS", "320000", [["USDT", "500"]]],
  ["wARS 400000 (> 200 USD cap) / 500 USDT", "wARS", "400000", [["USDT", "500"]]],
  ["wARS 1 (tiny) / 50 USDT", "wARS", "1", [["USDT", "50"]]],
  ["wARS 15000 / 5000 wARS + 50 USDT (mixed)", "wARS", "15000", [["wARS", "5000"], ["USDT", "50"]]],
  ["wARS 15000 / nothing", "wARS", "15000", []],
  ["wBRL 50 / 50 USDT", "wBRL", "50", [["USDT", "50"]]],
  ["wBRL 900 (~165 USD) / 500 USDT", "wBRL", "900", [["USDT", "500"]]],
  ["wMXN 200 / 300 wMXN (direct)", "wMXN", "200", [["wMXN", "300"]]],
  ["wMXN 200 / only 50 USDT", "wMXN", "200", [["USDT", "50"]]],
  ["wCOP 40000 / 50000 wCOP (direct)", "wCOP", "40000", [["wCOP", "50000"]]],
  ["wPEN 40 / 50 wPEN (direct)", "wPEN", "40", [["wPEN", "50"]]],
  ["wCLP 10000 / 20000 wCLP (direct)", "wCLP", "10000", [["wCLP", "20000"]]],
];

console.log("refRates (units per USD):", Object.fromEntries(Object.entries(refRates).map(([k, v]) => [k, +(1 / (v as number)).toFixed(2)])));
for (const [name, out, amt, bals] of cases) {
  const o = T(out);
  const t0 = Date.now();
  try {
    const r = await solve(
      {
        invoice: { tokenOut: o.address, amountOut: parseUnits(amt, o.decimals), deadline },
        balances: bals.map(([s, a]) => ({ token: T(s).address, amount: parseUnits(a, T(s).decimals) })),
        refRates,
      },
      { quoter, capUsd: 200, feeTiers: [100], permit2Ready: [] },
    );
    const ms = Date.now() - t0;
    if (r.ok) {
      const legs = r.plan.legs.map((l) => `${sym(l.token)}:${l.path === "0x" ? "direct" : "swap"}:kind${l.kind}`).join(" + ");
      console.log(`OK    ${name.padEnd(46)} ${legs} | costBps=${r.plan.costBps} | ${ms} ms`);
    } else console.log(`NOPE  ${name.padEnd(46)} ${r.reason} (fallback ${r.fallback}) ${r.detail ?? ""} | ${ms} ms`);
  } catch (e) {
    console.log(`THROW ${name.padEnd(46)} ${(e as Error).message}`);
  }
}
