import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { SolveResult, SolverInput } from "@cobra/shared";
import { createMemoryRateLimiter } from "../lib/server/rate-limit";
import { createX402Gate, handleFxQuote, parseFxQuoteParams, X402_NETWORK, X402_PRICE_UNITS, type FxQuoteDeps } from "../lib/server/x402";
import { USDC, USDT, payer } from "./helpers";

const PAY_TO = getAddress("0x9E828B877EFCdb79B507fF6234d841A8265Cccd5");
const BASE = "https://cobra.test/api/x402/fx-quote";

function fakeFacilitator() {
  const f = {
    verify: vi.fn(async () => ({ isValid: true, payer: payer.address })),
    settle: vi.fn(async () => ({ success: true, transaction: `0x${"ab".repeat(32)}`, network: X402_NETWORK, payer: payer.address })),
    getSupported: vi.fn(async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: X402_NETWORK }], extensions: [], signers: {} })),
  };
  return f as typeof f & FacilitatorClient;
}

function okSolve(input: SolverInput): Promise<SolveResult> {
  const t = input.balances[0]!.token;
  return Promise.resolve({
    ok: true,
    plan: {
      legs: [{ token: t, amountIn: t === USDT.address ? 2_730_000n : 2_740_000n } as never],
      tokenOut: input.invoice.tokenOut,
      minOut: input.invoice.amountOut,
      costBps: t === USDT.address ? 8 : 12,
      naiveCostBps: null,
      savingsBps: 0,
      quotedAt: 0,
      expiresAt: 60_000,
    },
  });
}

function setup(solve: FxQuoteDeps["solve"] = okSolve) {
  const facilitator = fakeFacilitator();
  const solveSpy = vi.fn(solve);
  const deps: FxQuoteDeps = {
    gate: createX402Gate(facilitator, PAY_TO),
    solve: solveSpy,
    getReferenceRates: async () => ({ ARS: 1650 }),
    rateLimiter: createMemoryRateLimiter(),
    now: () => 1_793_900_000_000,
  };
  return { deps, facilitator, solveSpy };
}

/** What any x402 client does: read the 402, sign an EIP-3009 authorization (anvil test key), retry. */
async function paidHeaders(res: Response): Promise<Record<string, string>> {
  const http = new x402HTTPClient(new x402Client().register(X402_NETWORK, new ExactEvmScheme(payer)));
  const required = http.getPaymentRequiredResponse((h) => res.headers.get(h), await res.json().catch(() => undefined));
  return http.encodePaymentSignatureHeader(await http.createPaymentPayload(required));
}

describe("parseFxQuoteParams", () => {
  it("accepts ARS/BRL with up to 2 decimals and rejects the rest", () => {
    expect(parseFxQuoteParams(new URL(`${BASE}?currency=ars&amount=4500`))).toMatchObject({ ok: true, currency: "ARS", amountOut: 4500n * 10n ** 18n });
    expect(parseFxQuoteParams(new URL(`${BASE}?currency=BRL&amount=8.50`))).toMatchObject({ ok: true, currency: "BRL" });
    expect(parseFxQuoteParams(new URL(`${BASE}?currency=MXN&amount=10`))).toEqual({ ok: false, error: "unsupported_currency" });
    for (const a of ["", "0", "-1", "1e3", "1.234", "999999999"]) {
      expect(parseFxQuoteParams(new URL(`${BASE}?currency=ARS&amount=${a}`))).toEqual({ ok: false, error: "invalid_amount" });
    }
  });
});

describe("GET /api/x402/fx-quote", () => {
  it("bad parameters cost nothing: 400 before any facilitator call", async () => {
    const { deps, facilitator } = setup();
    const res = await handleFxQuote(new Request(`${BASE}?currency=MXN&amount=10`), deps);
    expect(res.status).toBe(400);
    expect(facilitator.getSupported).not.toHaveBeenCalled();
  });

  it("503 when x402 is not configured", async () => {
    const { deps } = setup();
    const res = await handleFxQuote(new Request(`${BASE}?currency=ARS&amount=4500`), { ...deps, gate: null });
    expect(res.status).toBe(503);
  });

  it("402 without payment, offering 0.001 USD₮ or USDC to the configured payTo", async () => {
    const { deps, solveSpy } = setup();
    const res = await handleFxQuote(new Request(`${BASE}?currency=ARS&amount=4500`), deps);
    expect(res.status).toBe(402);
    const http = new x402HTTPClient(new x402Client());
    const required = http.getPaymentRequiredResponse((h) => res.headers.get(h), await res.json().catch(() => undefined));
    expect(required.accepts.map((a) => [a.asset, a.amount, a.payTo, a.network])).toEqual([
      [USDC.address, X402_PRICE_UNITS, PAY_TO, X402_NETWORK],
      [USDT.address, X402_PRICE_UNITS, PAY_TO, X402_NETWORK],
    ]);
    expect(solveSpy).not.toHaveBeenCalled();
  });

  it("paid request: quote for each dollar stablecoin, then settlement", async () => {
    const { deps, facilitator, solveSpy } = setup();
    const first = await handleFxQuote(new Request(`${BASE}?currency=ARS&amount=4500`), deps);
    const res = await handleFxQuote(new Request(`${BASE}?currency=ARS&amount=4500`, { headers: await paidHeaders(first) }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      currency: "ARS",
      amount: "4500",
      deliver: { token: "wARS", amount: "4500" },
      referenceRate: 1650,
      venue: "uniswap_v3",
      indicative: true,
    });
    expect(body.quotes).toEqual([
      { payWith: "USDC", amountIn: "2.74", costBps: 12, ok: true },
      { payWith: "USDT", amountIn: "2.73", costBps: 8, ok: true },
    ]);
    expect(solveSpy).toHaveBeenCalledTimes(2);
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(res.headers.get("payment-response")).toBeTruthy();
  });

  it("no route: 502 and the payment is NOT settled", async () => {
    const { deps, facilitator } = setup(async () => ({ ok: false, reason: "no_route", fallback: "ripio" }));
    const first = await handleFxQuote(new Request(`${BASE}?currency=BRL&amount=8`), deps);
    const res = await handleFxQuote(new Request(`${BASE}?currency=BRL&amount=8`, { headers: await paidHeaders(first) }), deps);
    expect(res.status).toBe(502);
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("rejected payment from the facilitator: 402, no quote computed", async () => {
    const { deps, facilitator, solveSpy } = setup();
    facilitator.verify.mockResolvedValueOnce({ isValid: false, invalidReason: "insufficient_funds" } as never);
    const first = await handleFxQuote(new Request(`${BASE}?currency=ARS&amount=100`), deps);
    const res = await handleFxQuote(new Request(`${BASE}?currency=ARS&amount=100`, { headers: await paidHeaders(first) }), deps);
    expect(res.status).toBe(402);
    expect(solveSpy).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});
