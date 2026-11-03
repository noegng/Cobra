/**
 * Production wiring of ApiDeps from env (lazy singletons; nothing touches the network at build time).
 * Env (server): DATABASE_URL, RPC_URL, ROUTER_ADDRESS, QUOTER_V2_ADDRESS (optional override), KILL_SWITCH.
 */
import { createPublicClient, getAddress, http, isAddress, type Address } from "viem";
import { celo } from "viem/chains";
import { CELO, CELO_CHAIN_ID } from "@cobra/shared";
import { createDb, type Db } from "@cobra/db";
import { createReferenceRateSource, createUniswapQuoter, solve } from "@cobra/solver";
import type { ApiDeps } from "./api";
import { readPayerState, type MulticallClient } from "./balances";
import { createMemoryRateLimiter } from "./rate-limit";

let db: Db | null = null;
let deps: ApiDeps | null = null;

export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    db = createDb(url);
  }
  return db;
}

function envAddress(name: string, fallback: Address | null): Address | null {
  const v = process.env[name];
  if (v && isAddress(v, { strict: false })) return getAddress(v);
  return fallback;
}

export function getApiDeps(): ApiDeps {
  if (deps) return deps;
  // WS2: batch the solver's QuoterV2 eth_calls through Multicall3 (one round-trip per tick).
  const client = createPublicClient({ chain: celo, transport: http(process.env.RPC_URL || CELO.rpcUrl), batch: { multicall: true } });
  const quoterAddress = envAddress("QUOTER_V2_ADDRESS", CELO.uniswapV3.quoterV2.address)!;
  const quoter = createUniswapQuoter(client as Parameters<typeof createUniswapQuoter>[0], quoterAddress);
  const rates = createReferenceRateSource(); // ARS = dólar cripto, BRL; cached 60 s, never throws
  deps = {
    db: getDb(),
    now: () => Date.now(),
    chainId: CELO_CHAIN_ID,
    router: envAddress("ROUTER_ADDRESS", null),
    permit2: CELO.permit2.address,
    readPayerState: (payer) => readPayerState(client as unknown as MulticallClient, payer, CELO.permit2.address),
    getReferenceRates: () => rates(),
    // Every verified pool is on the 0.01% tier: feeTiers [100] cuts ~30 eth_calls to ~12 per quote.
    solve: (input, opts) => solve(input, { quoter, capUsd: opts.capUsd, permit2Ready: opts.permit2Ready, feeTiers: [100] }),
    verifyTypedData: (args) => client.verifyTypedData(args as Parameters<typeof client.verifyTypedData>[0]),
    rateLimiter: createMemoryRateLimiter(),
    env: process.env,
  };
  return deps;
}
