import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { invoices, payments, type Db } from "@cobra/db";
import { INVOICE_TTL_SECONDS, tokenBySymbol } from "@cobra/shared";
import { buildTools, newEffects, TOOL_NAMES, type AgentEffects, type ToolContext } from "../src/agent";
import { csvCell } from "../src/invoices";
import { getMerchant } from "../src/merchants";
import { readState, stateKeys, type PendingPayout } from "../src/state";
import { ADDR_A, ADDR_B, BASE_URL, createTestDb, seedMerchant } from "./helpers";

const NOW = new Date("2026-11-02T15:00:00.000Z"); // 12:00 in Buenos Aires

async function setup(db: Db, telegramUserId: bigint, over: Parameters<typeof seedMerchant>[1] = { telegramUserId }) {
  const merchant = await seedMerchant(db, { ...over, telegramUserId });
  const ctx: ToolContext = { db, merchant, publicBaseUrl: BASE_URL, now: () => NOW, env: {} };
  const effects: AgentEffects = newEffects();
  const tools = buildTools(ctx, effects);
  const call = <K extends keyof typeof tools>(name: K, input: unknown) =>
    (tools[name].execute as (i: unknown, o: unknown) => Promise<any>)(input, { toolCallId: "t", messages: [] });
  return { merchant, ctx, effects, tools, call };
}

describe("agent tools (PGlite)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("exposes exactly the plan §7 tools and nothing that moves funds", async () => {
    const { tools } = await setup(db, 1n);
    expect(Object.keys(tools).sort()).toEqual([...TOOL_NAMES].sort());
    for (const name of Object.keys(tools)) expect(name).not.toMatch(/send|transfer|pay(?!ment)|sign|swap|approve|move/i);
  });

  it("create_invoice: deterministic parse, 1:1 wFIAT base units, frozen merchant address, TTL, sequential refs", async () => {
    const { call, effects, merchant } = await setup(db, 1n);
    const r1 = await call("create_invoice", { amount: "4.500,50", description: "café" });
    expect(r1).toMatchObject({ ok: true, reference: "A-0001", amount_display: "$ 4.500,50 pesos argentinos", status: "open" });
    const r2 = await call("create_invoice", { amount: "2 mil" });
    expect(r2.reference).toBe("A-0002");

    const rows = await db.select().from(invoices).where(eq(invoices.merchantId, merchant.id)).orderBy(invoices.reference);
    expect(rows).toHaveLength(2);
    const [a, b] = rows;
    expect(a!.amountLocal).toBe("4500.5");
    expect(a!.amountOut).toBe((45005n * 10n ** 17n).toString());
    expect(a!.currency).toBe("ARS");
    expect(a!.tokenOut).toBe(tokenBySymbol("wARS")!.address);
    expect(a!.merchantAddress).toBe(ADDR_A);
    expect(a!.id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a!.expiresAt.getTime() - NOW.getTime()).toBe(INVOICE_TTL_SECONDS * 1000);
    expect(b!.amountOut).toBe((2000n * 10n ** 18n).toString());
    expect(effects.invoices.map((i) => i.reference)).toEqual(["A-0001", "A-0002"]);
  });

  it("create_invoice: ambiguous / foreign amounts create nothing and return a typed error", async () => {
    const { call } = await setup(db, 1n);
    expect(await call("create_invoice", { amount: "4,500" })).toMatchObject({ ok: false, error: "ambiguous" });
    expect(await call("create_invoice", { amount: "10 usd" })).toMatchObject({ ok: false, error: "foreign_currency" });
    expect(await db.select().from(invoices)).toHaveLength(0);
  });

  it("create_invoice: rejects settlement token != wFIAT of the invoice currency", async () => {
    const { call } = await setup(db, 1n, { telegramUserId: 1n, settlementToken: tokenBySymbol("USDC")!.address });
    expect(await call("create_invoice", { amount: "100" })).toMatchObject({ ok: false, error: "unsupported_settlement" });
  });

  it("create_invoice: per-merchant rate limit (10/min)", async () => {
    const { call } = await setup(db, 1n);
    for (let i = 0; i < 10; i++) expect((await call("create_invoice", { amount: String(100 + i) })).ok).toBe(true);
    expect(await call("create_invoice", { amount: "999" })).toMatchObject({ ok: false, error: "rate_limited" });
    // another merchant is unaffected
    const other = await setup(db, 2n);
    expect((await other.call("create_invoice", { amount: "50" })).ok).toBe(true);
  });

  it("list_invoices / invoice_status (with Celoscan link) / cancel_invoice (open only)", async () => {
    const { call, merchant } = await setup(db, 1n);
    await call("create_invoice", { amount: "100" });
    await call("create_invoice", { amount: "200" });
    const list = await call("list_invoices", {});
    expect(list.count).toBe(2);
    expect(list.invoices[0].reference).toBe("A-0002");

    // mark A-0001 paid with a payment row
    const [inv1] = await db.select().from(invoices).where(eq(invoices.reference, "A-0001"));
    const txHash = `0x${"ab".repeat(32)}`;
    await db.update(invoices).set({ status: "paid", paidAt: NOW }).where(eq(invoices.id, inv1!.id));
    await db.insert(payments).values({
      invoiceId: inv1!.id, txHash, logIndex: 0, payer: ADDR_B, tokenOut: inv1!.tokenOut, amountOut: inv1!.amountOut,
      blockNumber: 1n, paidAt: NOW,
    });
    const st = await call("invoice_status", { invoice: "a-1" });
    expect(st).toMatchObject({ found: true, status: "paid", tx_hash: txHash, celoscan_url: `https://celoscan.io/tx/${txHash}` });
    expect((await call("invoice_status", { invoice: "last" })).reference).toBe("A-0002");
    expect(await call("invoice_status", { invoice: "A-0099" })).toEqual({ found: false });

    expect(await call("cancel_invoice", { invoice: "A-0001" })).toMatchObject({ ok: false, error: "not_open", status: "paid" });
    expect(await call("cancel_invoice", { invoice: "A-0002" })).toMatchObject({ ok: true, status: "cancelled" });
    expect(await call("cancel_invoice", { invoice: "A-0002" })).toMatchObject({ ok: false, error: "not_open" });
    expect((await call("list_invoices", { status: "cancelled" })).count).toBe(1);
    expect(merchant.id).toBeTruthy();
  });

  it("merchant scoping: B can never see or cancel A's invoices, by reference or by raw id", async () => {
    const a = await setup(db, 1n);
    const b = await setup(db, 2n, { telegramUserId: 2n, payoutAddress: ADDR_B });
    await a.call("create_invoice", { amount: "100", description: "secreto de A" });
    const [invA] = await db.select().from(invoices);

    expect((await b.call("list_invoices", {})).count).toBe(0);
    expect(await b.call("invoice_status", { invoice: "A-0001" })).toEqual({ found: false });
    expect(await b.call("invoice_status", { invoice: invA!.id })).toEqual({ found: false });
    expect(await b.call("invoice_status", { invoice: "last" })).toEqual({ found: false });
    expect(await b.call("cancel_invoice", { invoice: invA!.id })).toEqual({ ok: false, error: "not_found" });
    expect(await b.call("cancel_invoice", { invoice: "A-0001" })).toEqual({ ok: false, error: "not_found" });
    expect((await b.call("daily_summary", {})).created).toBe(0);
    const [still] = await db.select().from(invoices);
    expect(still!.status).toBe("open");

    // B's own numbering starts at A-0001 independently
    expect((await b.call("create_invoice", { amount: "5" })).reference).toBe("A-0001");
    expect((await a.call("list_invoices", {})).count).toBe(1);
  });

  it("daily_summary: totals, counts and a CSV document with formula-injection guard", async () => {
    const { call, effects } = await setup(db, 1n);
    await call("create_invoice", { amount: "4.500", description: "=HYPERLINK(\"x\")" });
    await call("create_invoice", { amount: "30,25", description: "corte, barba" });
    await db.update(invoices).set({ status: "paid", paidAt: NOW }).where(eq(invoices.reference, "A-0001"));
    const s = await call("daily_summary", {});
    expect(s).toMatchObject({ date: "2026-11-02", paid_total_display: "$ 4.500 pesos argentinos", paid_count: 1, created: 2, open: 1, csv_sent: true });
    const csv = effects.documents[0]!.content;
    expect(effects.documents[0]!.filename).toBe("cobra-2026-11-02.csv");
    expect(csv.split("\r\n")[0]).toBe("reference,invoice_id,created_at,status,amount,currency,description,paid_at,tx_hash,amount_out,token_out");
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`"corte, barba"`);
    expect(csv).toContain("2026-11-02 12:00:00"); // local time (Buenos Aires)
    expect(csvCell("+1")).toBe("'+1");

    const other = await call("daily_summary", { date: "2026-11-01" });
    expect(other).toMatchObject({ created: 0, paid_count: 0, csv_sent: false });
  });

  it("withdraw_link: public Ripio off-ramp link with steps (token, Celo, payout address)", async () => {
    const { call } = await setup(db, 1n);
    const r = await call("withdraw_link", {});
    expect(r.url).toMatch(/^https:\/\/ramp\.ripio\.com\/off-ramp(\?country=[A-Z]{2}&chain=42220&token=W[A-Z]{3})?$/);
    expect(r.message).toContain("wARS");
    expect(r.message).toContain("Celo");
    expect(r.message).toContain(ADDR_A);
  });

  it("set_preferences: language applies, foreign settlement token refused, payout address only proposed", async () => {
    const { call, merchant } = await setup(db, 1n);
    const r = await call("set_preferences", { language: "en", settlement_token: "wBRL", payout_address: ADDR_B });
    expect(r.language).toEqual({ ok: true, value: "en" });
    expect(r.settlement_token).toMatchObject({ ok: false, error: "unsupported" });
    expect(r.payout_address).toEqual({ ok: true, status: "awaiting_merchant_confirmation_button" });

    const fresh = await getMerchant(db, merchant.id);
    expect(fresh!.language).toBe("en");
    expect(fresh!.payoutAddress).toBe(ADDR_A); // unchanged until the button is tapped
    const pending = await readState<PendingPayout>(db, stateKeys.pendingPayout(merchant.id));
    expect(pending!.address).toBe(ADDR_B);

    expect((await call("set_preferences", { payout_address: "0x123" })).payout_address).toEqual({ ok: false, error: "invalid" });
    expect((await call("set_preferences", { payout_address: tokenBySymbol("wARS")!.address })).payout_address).toEqual({
      ok: false,
      error: "forbidden",
    });
  });
});
