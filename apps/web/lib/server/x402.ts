/**
 * Paid FX quote over x402, settled through Celo's hosted facilitator (https://api.x402.celo.org).
 *
 *   GET /api/x402/fx-quote?currency=ARS&amount=4500
 *
 * Price: 0.001 USD₮ or USDC per call (EIP-3009, gasless for the caller; the facilitator submits the transfer).
 * Returns what it costs, in each dollar stablecoin, to deliver exactly `amount` of the local-currency wFIAT on Celo
 * through Uniswap V3, with the cost against the reference rate. Indicative: Textile FX RFQ is not queried (a firm RFQ
 * would be sent to fillers with no intent to trade), so wBRL prices here are the pool's, not the RFQ's.
 *
 * Order of operations: free parameter checks first (a bad request never costs anything), then the x402 payment is
 * verified, the quote is computed, and the payment is settled only when the quote succeeded.
 */
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type HTTPAdapter, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { getAddress, isAddress, type Address } from "viem";
import { CELO_CHAIN_ID, TOKENS, fromBaseUnits, toBaseUnits, type ReferenceRates, type SolveResult, type SolverInput, type TokenInfo } from "@cobra/shared";
import { apiError, clientIp, json } from "./http";
import type { RateLimiter } from "./rate-limit";

export const X402_FACILITATOR_URL = "https://api.x402.celo.org";
export const X402_ROUTE = "GET /api/x402/fx-quote";
export const X402_NETWORK = `eip155:${CELO_CHAIN_ID}` as const;
/** 0.001 USD in 6-decimal base units. */
export const X402_PRICE_UNITS = "1000";
/** Currencies with a verified wFIAT pool on Celo (packages/shared/src/chain.ts). */
export const FX_QUOTE_CURRENCIES = ["ARS", "BRL"] as const;
/** Largest quotable amount, in local currency units (keeps quotes inside pool depth and the RPC budget). */
const MAX_LOCAL_UNITS = 10_000_000n;

const PAY_TOKENS = TOKENS.filter((t) => t.symbol === "USDT" || t.symbol === "USDC");
const QUOTE_WITH = TOKENS.filter((t) => t.symbol === "USDT" || t.symbol === "USDC");

export interface FxQuoteDeps {
  /** null when X402_API_KEY / X402_PAY_TO are not configured: the endpoint answers 503. */
  gate: x402HTTPResourceServer | null;
  /** Uniswap-only solver call (no Textile). */
  solve: (input: SolverInput) => Promise<SolveResult>;
  getReferenceRates: () => Promise<ReferenceRates>;
  rateLimiter: RateLimiter;
  now: () => number;
}

export function x402Routes(payTo: Address): RoutesConfig {
  return {
    [X402_ROUTE]: {
      accepts: PAY_TOKENS.map((t) => ({
        scheme: "exact",
        network: X402_NETWORK,
        payTo,
        price: { amount: X402_PRICE_UNITS, asset: t.address, extra: { name: t.eip712!.name, version: t.eip712!.version } },
        maxTimeoutSeconds: 120,
      })),
      description: "Cobrá FX quote: cost in USD₮ / USDC to deliver an exact wARS or wBRL amount on Celo (Uniswap V3)",
      mimeType: "application/json",
      serviceName: "Cobrá",
    },
  };
}

/** Resource server wired to a facilitator (Celo's in production, a fake in tests). */
export function createX402Gate(facilitator: FacilitatorClient, payTo: Address): x402HTTPResourceServer {
  const server = new x402ResourceServer(facilitator);
  server.register(X402_NETWORK, new ExactEvmScheme());
  return new x402HTTPResourceServer(server, x402Routes(payTo));
}

/** Production gate from env, or null when not configured. The API key is server-only. */
export function x402GateFromEnv(env: Record<string, string | undefined>): x402HTTPResourceServer | null {
  const key = env.X402_API_KEY;
  const payTo = env.X402_PAY_TO;
  if (!key || !payTo || !isAddress(payTo, { strict: false })) return null;
  const headers = { "X-API-Key": key };
  const facilitator = new HTTPFacilitatorClient({
    url: env.X402_FACILITATOR_URL || X402_FACILITATOR_URL,
    createAuthHeaders: async () => ({ verify: headers, settle: headers, supported: headers }),
  });
  return createX402Gate(facilitator, getAddress(payTo));
}

const inits = new WeakMap<x402HTTPResourceServer, Promise<void>>();
/** Fetches the facilitator's /supported once per gate; a failure is retried on the next request. */
function initialized(gate: x402HTTPResourceServer): Promise<void> {
  let p = inits.get(gate);
  if (!p) {
    p = gate.initialize().catch((e) => {
      inits.delete(gate);
      throw e;
    });
    inits.set(gate, p);
  }
  return p;
}

function adapter(req: Request, url: URL): HTTPAdapter {
  return {
    getHeader: (name) => req.headers.get(name) ?? undefined,
    getMethod: () => req.method,
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => req.headers.get("accept") ?? "",
    getUserAgent: () => req.headers.get("user-agent") ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name) => url.searchParams.get(name) ?? undefined,
  };
}

function toResponse(r: { status: number; headers: Record<string, string>; body?: unknown }): Response {
  return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...r.headers },
  });
}

/** Free, deterministic parameter parsing. */
export function parseFxQuoteParams(url: URL): { ok: true; currency: string; amount: string; token: TokenInfo; amountOut: bigint } | { ok: false; error: string } {
  const currency = (url.searchParams.get("currency") ?? "").toUpperCase();
  const amount = url.searchParams.get("amount") ?? "";
  if (!(FX_QUOTE_CURRENCIES as readonly string[]).includes(currency)) return { ok: false, error: "unsupported_currency" };
  const token = TOKENS.find((t) => t.kind === "wfiat" && t.currency === currency);
  if (!token) return { ok: false, error: "unsupported_currency" };
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(amount)) return { ok: false, error: "invalid_amount" };
  const amountOut = toBaseUnits(amount, token.decimals);
  if (amountOut <= 0n || amountOut > MAX_LOCAL_UNITS * 10n ** BigInt(token.decimals)) return { ok: false, error: "invalid_amount" };
  return { ok: true, currency, amount, token, amountOut };
}

/** A balance no quote can exhaust, so the solver prices a single-token route for each dollar stablecoin. */
const UNBOUNDED = 10n ** 30n;

export async function handleFxQuote(req: Request, deps: FxQuoteDeps): Promise<Response> {
  const wait = deps.rateLimiter.hit("quote", clientIp(req), deps.now());
  if (wait > 0) return apiError(429, "rate_limited", { retryAfter: wait });
  const url = new URL(req.url);
  const p = parseFxQuoteParams(url);
  if (!p.ok) return apiError(400, p.error, { currencies: FX_QUOTE_CURRENCIES });
  if (!deps.gate) return apiError(503, "not_configured");

  const ctx = {
    adapter: adapter(req, url),
    path: url.pathname,
    method: req.method,
    paymentHeader: req.headers.get("payment-signature") ?? req.headers.get("x-payment") ?? undefined,
  };
  try {
    await initialized(deps.gate);
  } catch {
    return apiError(503, "facilitator_unavailable");
  }
  const gate = await deps.gate.processHTTPRequest(ctx);
  if (gate.type === "payment-error") return toResponse(gate.response);
  if (gate.type !== "payment-verified") return apiError(500, "x402_route_missing");

  // Paid work. Any failure here returns before settlement: the caller is not charged.
  let body: unknown;
  try {
    const refRates = await deps.getReferenceRates();
    const quotes = [];
    for (const t of QUOTE_WITH) {
      const r = await deps.solve({
        invoice: { tokenOut: p.token.address, amountOut: p.amountOut, deadline: BigInt(Math.floor(deps.now() / 1000) + 600) },
        balances: [{ token: t.address, amount: UNBOUNDED }],
        refRates,
      });
      quotes.push(
        r.ok
          ? { payWith: t.symbol, amountIn: fromBaseUnits(r.plan.legs.reduce((s, l) => s + l.amountIn, 0n), t.decimals), costBps: r.plan.costBps, ok: true as const }
          : { payWith: t.symbol, ok: false as const, reason: r.reason },
      );
    }
    // Not settling is enough to leave the caller uncharged: the exact-scheme authorization simply expires.
    if (!quotes.some((q) => q.ok)) return apiError(502, "no_route", { quotes });
    body = {
      currency: p.currency,
      amount: p.amount,
      deliver: { token: p.token.symbol, address: p.token.address, amount: fromBaseUnits(p.amountOut, p.token.decimals) },
      referenceRate: refRates[p.currency as keyof ReferenceRates] ?? null,
      venue: "uniswap_v3",
      indicative: true,
      quotedAt: new Date(deps.now()).toISOString(),
      quotes,
    };
  } catch {
    return apiError(502, "upstream_unavailable");
  }

  const settled = await deps.gate.processSettlement(gate.paymentPayload, gate.paymentRequirements, gate.declaredExtensions, { request: ctx });
  if (!settled.success) return toResponse(settled.response);
  return json(body, 200, settled.headers);
}
