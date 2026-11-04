import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { PullKind, TEXTILE_REACTOR_CELO, decodeTextileVenue, isTextileVenue, type SolverInput } from "@cobra/shared";
import { createTextileClient, solve, type SolveResultEx, type SolverOptions } from "../src/index";
import { RATES, T, ars, baseOpts, brl, invoiceArs, mainnetLikePools, sim, usd } from "./helpers";

const ROUTER_V2 = getAddress("0x00000000000000000000000000000000000000b2");
const NOW = 1_700_000_000_000;
const ORDER = "0x" + "ab".repeat(40);
const SIG = "0x" + "cd".repeat(65);

/** In-memory fake of the Textile v2 API: records calls, serves canned or computed answers. */
function fakeTextile(over: {
  previewTakerPays?: bigint;
  firmTakerPays?: bigint;
  taker?: string;
  reactor?: string;
  buyAmount?: bigint;
  expiresInMs?: number;
  status?: "quoted" | "no_quote";
  previewHttp?: number;
  hang?: "preview" | "request";
  malformed?: "preview" | "request";
  orders?: unknown[];
} = {}) {
  const calls: { path: string; body: unknown; auth: string | null }[] = [];
  const A = ars("82500");
  const fetchFn = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, body, auth: new Headers(init.headers).get("authorization") });
    const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
    const hang = () =>
      new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    if (path === "/v2/rfq/preview") {
      if (over.hang === "preview") return hang();
      if (over.malformed === "preview") return reply(200, { data: { status: "preview", takerPays: "not-a-number" } });
      if (over.previewHttp) return reply(over.previewHttp, {});
      const tp = over.previewTakerPays ?? usd("49.95");
      return reply(200, { data: { status: "preview", sellAmount: tp.toString(), buyAmount: (over.buyAmount ?? A).toString(), takerPays: tp.toString() } });
    }
    if (path === "/v2/rfq/request") {
      if (over.hang === "request") return hang();
      if (over.malformed === "request") return reply(200, { data: { status: "quoted", rfqId: "rfq-1" } });
      if (over.status === "no_quote") return reply(200, { data: { status: "no_quote" } });
      const tp = over.firmTakerPays ?? usd("49.96");
      return reply(200, {
        data: {
          rfqId: "rfq-1",
          claimToken: "claim",
          status: "quoted",
          quote: {
            sellAmount: tp.toString(),
            buyAmount: (over.buyAmount ?? A).toString(),
            takerPays: tp.toString(),
            expiresAt: new Date(NOW + (over.expiresInMs ?? 120_000)).toISOString(),
            reactor: over.reactor ?? TEXTILE_REACTOR_CELO,
            taker: over.taker ?? ROUTER_V2,
            orders: over.orders ?? [{ encodedOrder: ORDER, signature: SIG, buyAmount: (over.buyAmount ?? A).toString() }],
          },
        },
      });
    }
    return reply(200, { data: {} });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls, paths: () => calls.map((c) => c.path) };
}

function setup(fake: ReturnType<typeof fakeTextile>, extra: Partial<SolverOptions> = {}, apiKey: string | undefined = "test-key") {
  const client = createTextileClient({ apiKey, fetch: fake.fetch, previewTimeoutMs: 40, requestTimeoutMs: 40 });
  const opts: SolverOptions = { ...baseOpts(), textile: { client, router: ROUTER_V2, corridors: [T.ARS] }, ...extra };
  return opts;
}

const input = (balUsdt = "1000"): SolverInput => ({
  invoice: invoiceArs("82500"),
  balances: [{ token: T.USDT, amount: usd(balUsdt) }],
  refRates: RATES,
});

function ok(r: SolveResultEx) {
  if (!r.ok) throw new Error(`expected ok: ${r.reason} ${r.detail}`);
  return r;
}

describe("solve + Textile", () => {
  it("Textile cheaper than Uniswap: single Textile leg, taker = router v2, meta carries rfqId", async () => {
    const fake = fakeTextile({ previewTakerPays: usd("49.95"), firmTakerPays: usd("49.96") });
    const r = ok(await solve(input(), setup(fake)));
    expect(r.meta?.venue).toBe("textile");
    expect(r.meta?.textile?.rfqId).toBe("rfq-1");
    expect(r.plan.legs).toHaveLength(1);
    const leg = r.plan.legs[0]!;
    expect(leg.token).toBe(T.USDT);
    expect(leg.amountIn).toBe(usd("49.96"));
    expect(leg.kind).toBe(PullKind.EIP3009);
    expect(leg.quotedOut).toBe(ars("82500"));
    expect(isTextileVenue(leg.path)).toBe(true);
    expect(decodeTextileVenue(leg.path)).toEqual([{ order: ORDER, sig: SIG }]);
    expect(r.plan.minOut).toBe(ars("82500"));
    expect(r.plan.costBps).toBeLessThan(0); // paying less than the reference value
    expect(r.plan.savingsBps).toBeGreaterThan(0); // vs the Uniswap route it beat
    const req = fake.calls.find((c) => c.path === "/v2/rfq/request")!;
    expect(req.body).toMatchObject({ taker: ROUTER_V2, chainId: 42220, sellToken: T.USDT, buyToken: T.ARS, buyAmount: ars("82500").toString() });
    expect(req.auth).toBe("Bearer test-key");
  });

  it("Textile worse than Uniswap: Uniswap plan, no firm request", async () => {
    const fake = fakeTextile({ previewTakerPays: usd("50.3") });
    const r = ok(await solve(input(), setup(fake)));
    expect(r.meta?.venue).toBe("uniswap_v3");
    expect(r.plan.legs[0]!.path.startsWith("0x5458")).toBe(false);
    expect(fake.paths()).toEqual(["/v2/rfq/preview"]);
  });

  it("firm quote worse than Uniswap although preview was better: dropped and given back", async () => {
    const fake = fakeTextile({ previewTakerPays: usd("49.95"), firmTakerPays: usd("50.4") });
    const r = ok(await solve(input(), setup(fake)));
    expect(r.meta?.venue).toBe("uniswap_v3");
    await new Promise((res) => setTimeout(res, 0));
    expect(fake.paths()).toContain("/v2/rfq/rfq-1/cancel");
  });

  it("no_quote falls back to Uniswap", async () => {
    const fake = fakeTextile({ status: "no_quote" });
    const r = ok(await solve(input(), setup(fake)));
    expect(r.meta?.venue).toBe("uniswap_v3");
  });

  it("preview timeout / http error / malformed => Uniswap", async () => {
    for (const over of [{ hang: "preview" as const }, { previewHttp: 500 }, { malformed: "preview" as const }]) {
      const fake = fakeTextile(over);
      const r = ok(await solve(input(), setup(fake)));
      expect(r.meta?.venue).toBe("uniswap_v3");
      expect(fake.paths()).toEqual(["/v2/rfq/preview"]);
    }
  });

  it("request timeout / malformed => Uniswap", async () => {
    for (const over of [{ hang: "request" as const }, { malformed: "request" as const }]) {
      const r = ok(await solve(input(), setup(fakeTextile(over))));
      expect(r.meta?.venue).toBe("uniswap_v3");
    }
  });

  it.each([
    ["wrong taker", { taker: "0x00000000000000000000000000000000000000c3" }],
    ["wrong reactor", { reactor: "0x00000000000000000000000000000000000000d4" }],
    ["wrong buyAmount", { buyAmount: ars("82499") }],
  ])("%s => Textile dropped and the quote cancelled", async (_n, over) => {
    // previewed amount is checked first for buyAmount; use a separate preview/firm mismatch otherwise
    const fake = fakeTextile(over);
    const r = ok(await solve(input(), setup(fake)));
    expect(r.meta?.venue).toBe("uniswap_v3");
    if (!("buyAmount" in over)) {
      await new Promise((res) => setTimeout(res, 0));
      expect(fake.paths()).toContain("/v2/rfq/rfq-1/cancel");
    }
  });

  it("firm buyAmount mismatch (preview ok) cancels the RFQ", async () => {
    const fake = fakeTextile({ orders: [{ encodedOrder: ORDER, signature: SIG, buyAmount: "1" }] });
    const r = ok(await solve(input(), setup(fake)));
    expect(r.meta?.venue).toBe("uniswap_v3");
    await new Promise((res) => setTimeout(res, 0));
    expect(fake.paths()).toContain("/v2/rfq/rfq-1/cancel");
  });

  it("takerPays above the payer's USD₮ balance => Uniswap path (or no Textile)", async () => {
    const fake = fakeTextile({ previewTakerPays: usd("49.95") });
    const r = await solve(input("40"), setup(fake));
    expect(r.ok === false || r.meta?.venue === "uniswap_v3").toBe(true);
    expect(fake.paths()).toEqual(["/v2/rfq/preview"]);
  });

  it("price guard: a Textile price far from the reference rate is refused", async () => {
    const fake = fakeTextile({ previewTakerPays: usd("40") }); // 20% cheaper than reference: suspicious
    const r = ok(await solve(input(), setup(fake)));
    expect(r.meta?.venue).toBe("uniswap_v3");
    expect(fake.paths()).toEqual(["/v2/rfq/preview"]);
  });

  it("expiry is clamped to Textile expiresAt - 20 s", async () => {
    const fake = fakeTextile({ expiresInMs: 50_000 });
    const r = ok(await solve(input(), setup(fake)));
    expect(r.plan.expiresAt).toBe(NOW + 30_000);
    expect(r.meta?.textile?.expiresAt).toBe(NOW + 50_000);
  });

  it("a Textile quote with too little life left is dropped", async () => {
    const fake = fakeTextile({ expiresInMs: 40_000 });
    const r = ok(await solve(input(), setup(fake)));
    expect(r.meta?.venue).toBe("uniswap_v3");
  });

  it("no corridor for tokenOut / no USD₮ balance / no API key: Textile never called", async () => {
    const a = fakeTextile();
    await solve(input(), setup(a, { textile: { client: createTextileClient({ apiKey: "k", fetch: a.fetch }), router: ROUTER_V2, corridors: [T.BRL] } }));
    expect(a.calls).toHaveLength(0);
    const b = fakeTextile();
    await solve({ ...input(), balances: [{ token: T.USDC, amount: usd("1000") }] }, setup(b));
    expect(b.calls).toHaveLength(0);
    const c = fakeTextile();
    const r = ok(await solve(input(), setup(c, {}, "")));
    expect(c.calls).toHaveLength(0);
    expect(r.meta?.venue).not.toBe("textile");
  });

  it("no textile option: result identical to v1 (no meta)", async () => {
    const r = await solve(input(), baseOpts());
    expect("meta" in r).toBe(false);
  });

  it("saving is measured against the Uniswap route even when our price guard refused it (one-sided wBRL pool)", async () => {
    // Pool sells wBRL at 5.20/USD vs a 5.40 reference (-3.7%, beyond the 350 bps BRL guard); Textile ~ at reference.
    const fake = fakeTextile({ buyAmount: brl("270"), previewTakerPays: usd("50.10"), firmTakerPays: usd("50.10") });
    const opts = setup(fake, { quoter: sim(mainnetLikePools({ brlPrice: 5.2 })) });
    opts.textile = { ...opts.textile!, corridors: [T.BRL] };
    const brlInput: SolverInput = {
      invoice: { tokenOut: T.BRL, amountOut: brl("270"), deadline: 2_000_000_000n },
      balances: [{ token: T.USDT, amount: usd("100") }],
      refRates: RATES,
    };
    const uniOnly = await solve(brlInput, baseOpts(sim(mainnetLikePools({ brlPrice: 5.2 }))));
    expect(uniOnly).toMatchObject({ ok: false, reason: "price_guard" });
    const r = ok(await solve(brlInput, opts));
    expect(r.meta?.venue).toBe("textile");
    expect(r.plan.costBps).toBeLessThan(50);
    expect(r.plan.naiveCostBps).toBeGreaterThan(350); // what Uniswap offered
    expect(r.plan.savingsBps).toBe(r.plan.naiveCostBps! - r.plan.costBps);
    expect(r.plan.savingsBps).toBeGreaterThan(300);
  });

  it("Textile rescues an invoice Uniswap cannot serve", async () => {
    const fake = fakeTextile();
    const opts = setup(fake, { quoter: { quoteExactOutput: async () => { throw new Error("no pool"); }, quoteExactInput: async () => { throw new Error("no pool"); } } });
    const r = ok(await solve(input(), opts));
    expect(r.meta?.venue).toBe("textile");
    expect(r.plan.naiveCostBps).toBeNull();
  });

  it("client never logs or leaks the API key", async () => {
    const logs: string[] = [];
    const client = createTextileClient({ apiKey: "SECRET-KEY-123", fetch: (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch, log: (m, e) => logs.push(m + JSON.stringify(e)) });
    const res = await client.preview({ chainId: 42220, sellToken: T.USDT, buyToken: T.ARS, buyAmount: 1n });
    expect(res.ok).toBe(false);
    expect(logs.join("")).not.toContain("SECRET-KEY");
    expect(createTextileClient({}).enabled).toBe(false);
  });
});

export type { Address };
