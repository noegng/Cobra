/**
 * Production wiring of ApiDeps from env (lazy singletons; nothing touches the network at build time).
 * Env (server): DATABASE_URL, RPC_URL, ROUTER_ADDRESS, QUOTER_V2_ADDRESS (optional override), KILL_SWITCH.
 */
import { createPublicClient, getAddress, http, isAddress, type Address } from "viem";
import { celo } from "viem/chains";
import { CELO, CELO_CHAIN_ID } from "@cobra/shared";
import { createDb, type Db } from "@cobra/db";
import { createUniswapQuoter, solve } from "@cobra/solver";
import type { ApiDeps } from "./api";
import { readPayerState, type MulticallClient } from "./balances";
import { createMemoryRateLimiter } from "./rate-limit";
import { getReferenceRates } from "./rates";

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
  const client = createPublicClient({ chain: celo, transport: http(process.env.RPC_URL || CELO.rpcUrl) });
  const quoterAddress = envAddress("QUOTER_V2_ADDRESS", CELO.uniswapV3.quoterV2.address)!;
  let quoter: ReturnType<typeof createUniswapQuoter> | null = null;
  deps = {
    db: getDb(),
    now: () => Date.now(),
    chainId: CELO_CHAIN_ID,
    router: envAddress("ROUTER_ADDRESS", null),
    permit2: CELO.permit2.address,
    readPayerState: (payer) => readPayerState(client as unknown as MulticallClient, payer, CELO.permit2.address),
    getReferenceRates: () => getReferenceRates(),
    solve: (input, opts) => {
      // Created lazily so a not-yet-implemented solver only fails the quote call (503), never the build.
      quoter ??= createUniswapQuoter(client as Parameters<typeof createUniswapQuoter>[0], quoterAddress);
      return solve(input, { quoter, capUsd: opts.capUsd });
    },
    rateLimiter: createMemoryRateLimiter(),
    env: process.env,
  };
  return deps;
}
