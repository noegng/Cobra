/**
 * Production wiring of ApiDeps from env (lazy singletons; nothing touches the network at build time).
 * Env (server): DATABASE_URL, RPC_URL, ROUTER_ADDRESS, QUOTER_V2_ADDRESS (optional override), KILL_SWITCH,
 * TEXTILE_API_KEY (optional, server-only: enables the Textile RFQ route), TEXTILE_ENABLED ("false" = off).
 */
import { createPublicClient, getAddress, hashTypedData, http, isAddress, type Address } from "viem";
import { celo } from "viem/chains";
import { CELO, CELO_CHAIN_ID } from "@cobra/shared";
import { agentEventRecorder, createDb, type Db } from "@cobra/db";
import { createReferenceRateSource, createTextileClient, createUniswapQuoter, solve } from "@cobra/solver";
import type { ApiDeps } from "./api";
import { accountAcceptsSignature, isEip7702Delegation, readPayerState, type MulticallClient } from "./balances";
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
  // Textile FX RFQ (CobraRouterV2): only when the partner key AND a router address are configured, and not switched
  // off with TEXTILE_ENABLED=false. The key is server-side only (never NEXT_PUBLIC_).
  const routerAddr = envAddress("ROUTER_ADDRESS", null);
  const textileClient = createTextileClient({ apiKey: process.env.TEXTILE_API_KEY });
  const textileOn = textileClient.enabled && !!routerAddr && process.env.TEXTILE_ENABLED !== "false";
  deps = {
    db: getDb(),
    now: () => Date.now(),
    chainId: CELO_CHAIN_ID,
    router: routerAddr,
    textileEnabled: textileOn,
    cancelTextileRfq: textileOn ? async (id) => void (await textileClient.cancel(id)) : undefined,
    permit2: CELO.permit2.address,
    delegatedAccountAccepts: async (payer, typedData, signature) => {
      if (!isEip7702Delegation(await client.getCode({ address: payer }))) return null;
      return accountAcceptsSignature(client, payer, hashTypedData(typedData as Parameters<typeof hashTypedData>[0]), signature);
    },
    readPayerState: (payer) => readPayerState(client as unknown as MulticallClient, payer, CELO.permit2.address),
    getReferenceRates: () => rates(),
    // Every verified pool is on the 0.01% tier: feeTiers [100] cuts ~30 eth_calls to ~12 per quote.
    solve: (input, opts) =>
      solve(input, {
        quoter,
        capUsd: opts.capUsd,
        permit2Ready: opts.permit2Ready,
        feeTiers: [100],
        ...(textileOn && routerAddr && { textile: { client: textileClient, router: routerAddr } }),
      }),
    verifyTypedData: (args) => client.verifyTypedData(args as Parameters<typeof client.verifyTypedData>[0]),
    rateLimiter: createMemoryRateLimiter(),
    recordEvent: agentEventRecorder(getDb(), (m, x) => console.warn(JSON.stringify({ msg: m, ...x }))),
    env: process.env,
  };
  return deps;
}
