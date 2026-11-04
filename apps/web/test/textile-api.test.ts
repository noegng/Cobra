import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { PullKind, deserializeLeg, encodeTextileVenue, type SerializedLeg } from "@cobra/shared";
import { quotes, submissions } from "@cobra/db";
import { handleQuote, handleSubmit } from "../lib/server/api";
import type { QuoteError, QuoteOk } from "../lib/wire";
import { USDT, payer, planFor, req, setup, signAll } from "./helpers";

const ROUTER_V2 = getAddress("0x00000000000000000000000000000000c0b4a002");
const TEXTILE_PATH = encodeTextileVenue([{ order: "0xabcd", sig: "0x1234" }]);

async function textileFixture(opts: { textileEnabled?: boolean } = {}) {
  const fx = await setup();
  fx.deps.router = ROUTER_V2;
  fx.deps.textileEnabled = opts.textileEnabled ?? true;
  const cancelled: string[] = [];
  fx.deps.cancelTextileRfq = async (id) => void cancelled.push(id);
  let n = 0;
  fx.setSolver((input) => {
    const id = `rfq-${++n}`;
    return {
      ok: true,
      plan: planFor(input, fx.clock.now, [
        { token: USDT.address, amountIn: 1_470_000n, kind: PullKind.EIP3009, path: TEXTILE_PATH, quotedOut: input.invoice.amountOut },
      ]),
      meta: { venue: "textile", textile: { rfqId: id, expiresAt: fx.clock.now + 120_000, takerPays: "1470000" } },
    };
  });
  return { fx, cancelled };
}

const quote = async (fx: Awaited<ReturnType<typeof setup>>) => {
  const res = await handleQuote(req("POST", { payer: payer.address }), fx.invoiceId, fx.deps);
  return { res, body: (await res.json()) as QuoteOk & QuoteError };
};

describe("Web API with a v2 router + Textile plan", () => {
  it("signs against the v2 router, stores venue + rfqId + router, submit stores the Textile path", async () => {
    const { fx } = await textileFixture();
    const { res, body } = await quote(fx);
    expect(res.status).toBe(200);
    expect(body.router).toBe(ROUTER_V2);
    expect(body.toSign[0]!.typedData!.message).toMatchObject({ to: ROUTER_V2 });
    const [q] = await fx.db.select().from(quotes).where(eq(quotes.id, body.quoteId));
    expect(q!.plan).toMatchObject({ venue: "textile", router: ROUTER_V2, textile: { rfqId: "rfq-1" } });

    const signatures = await signAll(body.toSign);
    const sub = await handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), fx.invoiceId, fx.deps);
    expect(sub.status).toBe(202);
    const { submissionId } = await sub.json();
    const [s] = await fx.db.select().from(submissions).where(eq(submissions.id, submissionId));
    expect((s!.legs as SerializedLeg[]).map(deserializeLeg)[0]!.path).toBe(TEXTILE_PATH);
  });

  it("a quote built for the v2 router cannot be submitted once ROUTER_ADDRESS points elsewhere", async () => {
    const { fx } = await textileFixture();
    const { body } = await quote(fx);
    const signatures = await signAll(body.toSign);
    fx.deps.router = getAddress("0x00000000000000000000000000000000c0b4a000");
    const res = await handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), fx.invoiceId, fx.deps);
    expect(res.status).toBe(410);
  });

  it("Textile plan while Textile is disabled => no_route (defense in depth)", async () => {
    const { fx } = await textileFixture({ textileEnabled: false });
    const { res, body } = await quote(fx);
    expect(res.status).toBe(422);
    expect(body.error).toBe("no_route");
  });

  it("plan whose venue metadata disagrees with the path => no_route", async () => {
    const { fx } = await textileFixture();
    fx.setSolver((input) => ({ ok: true, plan: planFor(input, fx.clock.now), meta: { venue: "textile" } }));
    expect((await quote(fx)).res.status).toBe(422);
  });

  it("requesting a new quote cancels the previous unused Textile RFQ", async () => {
    const { fx, cancelled } = await textileFixture();
    await quote(fx);
    expect(cancelled).toEqual([]);
    fx.clock.now += 5_000;
    await quote(fx);
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toEqual(["rfq-1"]);
  });

  it("Uniswap plans are stored with venue uniswap_v3", async () => {
    const fx = await setup();
    const { body } = await quote(fx);
    const [q] = await fx.db.select().from(quotes).where(eq(quotes.id, body.quoteId));
    expect(q!.plan).toMatchObject({ venue: "uniswap_v3" });
  });
});
