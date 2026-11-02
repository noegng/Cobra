/**
 * READ-ONLY. Queries the real Uniswap V3 QuoterV2 on Celo mainnet (eth_call only, no keys, no transactions)
 * for 50 / 500 / 5000 USD invoices in wARS and wBRL and several payer portfolios, runs the solver on them and
 * writes every quote + result to test/fixtures/real-quotes.json. test/replay.test.ts replays the fixture offline.
 *
 *   pnpm --filter @cobra/solver replay            # RPC_URL overrides https://forno.celo.org
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { celo } from "viem/chains";
import { CELO } from "@cobra/shared";
import { createUniswapQuoter, fetchReferenceRates, solve } from "../src/index";
import {
  REPLAY_CAP_USD,
  REPLAY_NOW,
  buildScenarios,
  recordingQuoter,
  toJson,
  type QuoteRecord,
  type ReplayFixture,
} from "./replay-lib";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "test", "fixtures", "real-quotes.json");

async function main() {
  const rpc = process.env.RPC_URL ?? CELO.rpcUrl;
  const quoterV2 = CELO.uniswapV3.quoterV2.address;
  if (!quoterV2) throw new Error("QuoterV2 address unknown (CELO.uniswapV3.quoterV2)");
  const client = createPublicClient({ chain: celo, transport: http(rpc, { retryCount: 3, timeout: 20_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 42220) throw new Error(`expected Celo mainnet (42220), got ${chainId}`);
  const blockNumber = await client.getBlockNumber();

  const refRates = await fetchReferenceRates();
  if (!refRates.ARS || !refRates.BRL) throw new Error(`FX unavailable: ${JSON.stringify(refRates)}`);
  console.log(`block ${blockNumber}, ARS/USD ${(1 / refRates.ARS).toFixed(2)} (cripto), BRL/USD ${(1 / refRates.BRL).toFixed(4)}`);

  const quotes: Record<string, QuoteRecord> = {};
  const quoter = recordingQuoter(createUniswapQuoter(client as never, quoterV2), quotes);
  const scenarios = buildScenarios(refRates);
  const results: ReplayFixture["results"] = {};
  for (const s of scenarios) {
    const r = await solve(s.input, { quoter, capUsd: REPLAY_CAP_USD, now: () => REPLAY_NOW, maxConcurrentQuotes: 4 });
    results[s.name] = r;
    console.log(
      s.name.padEnd(42),
      r.ok
        ? `legs=${r.plan.legs.length} cost=${r.plan.costBps}bps naive=${r.plan.naiveCostBps}bps savings=${r.plan.savingsBps}bps`
        : `${r.reason} (${r.detail})`,
    );
  }

  const fixture: ReplayFixture = {
    meta: { recordedAt: new Date().toISOString(), rpc, quoterV2, blockNumber: blockNumber.toString() },
    refRates,
    scenarios,
    quotes,
    results,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, toJson(fixture) + "\n");
  console.log(`wrote ${Object.keys(quotes).length} quotes, ${scenarios.length} scenarios -> ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
