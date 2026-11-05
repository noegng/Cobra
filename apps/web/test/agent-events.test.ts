import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { privateKeyToAccount } from "viem/accounts";
import { deserializePlan, type SerializedPlan } from "@cobra/shared";
import { FLAG_KEYS, agentEventRecorder, agentEvents, invoices, onchainInvoiceFromRow, quotes, setFlag, submissions, type Db } from "@cobra/db";
import { handleQuote, handleSubmit } from "../lib/server/api";
import { JournalView } from "../components/journal-view";
import { queryJournal, routeEntry } from "../lib/server/journal";
import { buildLegSigning } from "../lib/server/signing";
import type { QuoteError, QuoteOk } from "../lib/wire";
import { MERCHANT_PAYOUT, ROUTER, USDT, WARS, payer, req, setup, signAll } from "./helpers";

type Fx = Awaited<ReturnType<typeof setup>>;
const merchantAcc = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

async function withRecorder() {
  const fx = await setup();
  fx.deps.recordEvent = agentEventRecorder(fx.db);
  return fx;
}
async function events(db: Db) {
  await new Promise((r) => setTimeout(r, 150)); // fire-and-forget writes
  return (await db.select({ kind: agentEvents.kind, code: agentEvents.code }).from(agentEvents)).map((e) => `${e.kind}:${e.code}`);
}
async function quote(fx: Fx, who = payer.address) {
  const res = await handleQuote(req("POST", { payer: who }), fx.invoiceId, fx.deps);
  return { res, body: (await res.json()) as QuoteOk & QuoteError };
}
async function submit(fx: Fx, accepts?: boolean) {
  if (accepts !== undefined) fx.deps.delegatedAccountAccepts = async () => accepts;
  const { body } = await quote(fx);
  const signatures = await signAll(body.toSign);
  return handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), fx.invoiceId, fx.deps);
}

describe("WS15 agent_events: every refusal site writes its code", () => {
  it("quote self_payment", async () => {
    const fx = await withRecorder();
    expect((await quote(fx, MERCHANT_PAYOUT)).res.status).toBe(400);
    expect(await events(fx.db)).toEqual(["quote:self_payment"]);
  });
  it("quote price_guard is recorded, no_route is not (empty wallet, not a refusal)", async () => {
    for (const [reason, want] of [["price_guard", ["quote:price_guard"]], ["no_route", []]] as const) {
      const fx = await withRecorder();
      fx.setSolver(() => ({ ok: false, reason, fallback: "ripio", detail: "x" }));
      expect((await quote(fx)).res.status).toBe(422);
      expect(await events(fx.db)).toEqual(want);
    }
  });
  it("quote over_cap from the solver -> cap_per_payment", async () => {
    const fx = await withRecorder();
    fx.setSolver(() => ({ ok: false, reason: "over_cap", fallback: "direct_wfiat", detail: "x" }));
    expect((await quote(fx)).res.status).toBe(422);
    expect(await events(fx.db)).toEqual(["quote:cap_per_payment"]);
  });
  it("quote payer_blocked", async () => {
    const fx = await withRecorder();
    await fx.db.insert(submissions).values(
      [0, 1, 2].map((i) => ({ invoiceId: fx.invoiceId, payer: payer.address, legs: [], status: "failed" as const, error: "tx_reverted:Y", updatedAt: new Date(fx.clock.now - 60_000 * (i + 1)) })),
    );
    expect((await quote(fx)).res.status).toBe(429);
    expect(await events(fx.db)).toEqual(["submit:payer_blocked"]);
  });
  it("submit smart_account_unsupported", async () => {
    const fx = await withRecorder();
    expect((await submit(fx, false)).status).toBe(422);
    expect(await events(fx.db)).toEqual(["submit:smart_account_unsupported"]);
  });
  it("submit over cap -> cap_per_payment", async () => {
    const fx = await withRecorder();
    const { body } = await quote(fx);
    await setFlag(fx.db, FLAG_KEYS.caps, { perPaymentUsd: 0.01 });
    const res = await handleSubmit(req("POST", { quoteId: body.quoteId, signatures: await signAll(body.toSign) }), fx.invoiceId, fx.deps);
    expect(res.status).toBe(422);
    expect(await events(fx.db)).toEqual(["submit:cap_per_payment"]);
  });
  it("submit self_payment", async () => {
    const fx = await withRecorder();
    const { body } = await quote(fx);
    await fx.db.update(quotes).set({ payer: MERCHANT_PAYOUT }).where(eq(quotes.id, body.quoteId));
    const [q] = await fx.db.select().from(quotes).where(eq(quotes.id, body.quoteId));
    const [row] = await fx.db.select().from(invoices).where(eq(invoices.id, fx.invoiceId));
    const signing = buildLegSigning({ router: ROUTER, chainId: 42220, permit2: fx.deps.permit2, invoice: onchainInvoiceFromRow(row!), payer: MERCHANT_PAYOUT, legs: deserializePlan(q!.plan as SerializedPlan).legs });
    const signatures = await Promise.all(signing.map((x) => merchantAcc.signTypedData(x.typedData as never)));
    expect((await handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), fx.invoiceId, fx.deps)).status).toBe(400);
    expect(await events(fx.db)).toEqual(["submit:self_payment"]);
  });
  it("a failing writer (rejecting db or throwing hook) does not change the HTTP outcome", async () => {
    const broken = { insert: () => { throw new Error("db down"); } } as unknown as Db;
    for (const rec of [agentEventRecorder(broken), () => { throw new Error("boom"); }]) {
      const fx = await setup();
      fx.deps.recordEvent = rec;
      const { res, body } = await quote(fx, MERCHANT_PAYOUT);
      expect(res.status).toBe(400);
      expect(body).toEqual({ error: "self_payment" });
    }
  });
  it("no event for a normal payment", async () => {
    const fx = await withRecorder();
    expect((await submit(fx)).status).toBe(202);
    expect(await events(fx.db)).toEqual([]);
  });
});

describe("WS15 /proof aggregation", () => {
  it("counts the last 14 days by code and renders them (es/pt/en)", async () => {
    const fx = await setup();
    const now = new Date("2026-11-04T12:00:00Z");
    const d = (days: number) => new Date(now.getTime() - days * 86_400_000);
    await fx.db.insert(agentEvents).values([
      { kind: "quote", code: "price_guard", at: d(1) },
      { kind: "quote", code: "price_guard", at: d(3) },
      { kind: "submit", code: "cap_per_payment", at: d(2) },
      { kind: "quote", code: "price_guard", at: d(20) }, // outside the window
      { kind: "quote", code: "not_in_closed_list", at: d(1) }, // ignored
    ]);
    const j = await queryJournal(fx.db, { now });
    expect(j.refusals).toEqual([{ code: "price_guard", count: 2 }, { code: "cap_per_payment", count: 1 }]);
    const html = (lang: "es" | "pt" | "en") => renderToStaticMarkup(createElement(JournalView, { journal: j, lang }));
    expect(html("en")).toContain("Refusals by the agent (last 14 days)");
    expect(html("es")).toContain("Rechazos del agente (últimos 14 días)");
    expect(html("pt")).toContain("Recusas do agente (últimos 14 días)".replace("días", "dias"));
    expect(html("en")).toContain("Price outside the reference guard: 2");
  });
});

describe("WS15 real refund in the journal", () => {
  const base = { txHash: "0x" + "ab".repeat(32), payer: "0x0000000000000000000000000000000000000001", tokenOut: WARS.address, amountOut: (100n * 10n ** 18n).toString(), paidAt: new Date("2026-11-04T00:00:00Z"), costBps: null, savingsBps: null, paymentLegs: null, amountLocal: "100", currency: "ARS" };
  const plan = { legs: [{ token: USDT.address, amountIn: "60673", kind: 0, path: "0x", quotedOut: (100n * 10n ** 18n + 5n * 10n ** 17n).toString() }] };
  const html = (refundedOut: string | null, lang: "es" | "pt" | "en") => {
    const e = routeEntry({ ...base, plan, refundedOut });
    return renderToStaticMarkup(createElement(JournalView, { journal: { agent: { address: "0x1", attributionTag: "t" }, entries: [e], days: [], refusals: [] }, lang }));
  };
  it("real refund shown when known, quoted label otherwise (es/pt/en)", () => {
    expect(html("470000000000000000", "en")).toContain("Surplus refunded to the payer (actual, on-chain): 0.47 wARS");
    expect(html("470000000000000000", "en")).not.toContain("Quoted surplus");
    expect(html("470000000000000000", "es")).toContain("Excedente devuelto al pagador (real, on-chain)");
    expect(html("470000000000000000", "pt")).toContain("Excedente devolvido ao pagador (real, on-chain)");
    expect(html(null, "en")).toContain("Quoted surplus (refunded to the payer): 0.5 wARS");
    expect(html("0", "en")).not.toContain("urplus");
  });
});
