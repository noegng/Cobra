import { Api } from "grammy";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { invoices, type Db } from "@cobra/db";
import { tokenBySymbol } from "@cobra/shared";
import { buildTools, newEffects, type ToolContext } from "../src/agent";
import { registerBotCommands } from "../src/bot";
import { t } from "../src/i18n";
import { createInvoice, dailySummary } from "../src/invoices";
import { getMerchant } from "../src/merchants";
import { createNotifierWithApi } from "../src/notifier";
import {
  formatUsdCents,
  localPerUsdFixed,
  localToUsdBaseUnits,
  quoteUsdt,
  RATE_DECIMALS,
  rateToFixed,
} from "../src/usd";
import {
  ADDR_A,
  ADDR_B,
  BASE_URL,
  callbackUpdate,
  createTestDb,
  fakeApi,
  forbiddenModel,
  makeBot,
  seedMerchant,
  sent,
  textUpdate,
  texts,
} from "./helpers";

const NOW = new Date("2026-11-02T15:00:00.000Z");
const USDT = tokenBySymbol("USDT")!;
const WARS = tokenBySymbol("wARS")!;
const RATES = async () => ({ USD: 1, ARS: 1 / 1650, BRL: 1 / 5.4 });
const NO_RATES = async () => ({ USD: 1 });

const lastKeyboard = (calls: ReturnType<typeof makeBot>["calls"]) =>
  JSON.stringify(sent(calls, "sendMessage").at(-1)!.payload.reply_markup ?? null);

describe("USD₮ amountOut math (bigint, rounded up)", () => {
  it("4500 ARS at 1650 ARS/USD -> 2.727273 USD₮ (ceil of 2.7272727…)", () => {
    expect(localToUsdBaseUnits("4500", rateToFixed(1650)!)).toBe(2_727_273n);
    expect(localToUsdBaseUnits("1650", rateToFixed(1650)!)).toBe(1_000_000n); // exact: no extra unit
    expect(localToUsdBaseUnits("0.01", rateToFixed(1650)!)).toBe(7n); // 6.06 base units -> 7
    expect(localToUsdBaseUnits("0.01", rateToFixed(19_999)!)).toBe(1n); // 0.5 base unit -> 1, never 0
    expect(localToUsdBaseUnits("4500.5", rateToFixed(1650.42)!)).toBe(2_726_882n); // 2.72688164…
  });

  it("never gives the merchant less than the local value at the reference rate", () => {
    for (const [amount, rate] of [["4500", 1650], ["99999.99", 1649.37], ["1", 5.4321], ["123456", 4012.5]] as const) {
      const fixed = rateToFixed(rate)!;
      const out = localToUsdBaseUnits(amount, fixed);
      const localE = BigInt(amount.replace(".", "")) * 10n ** BigInt(18 - (amount.split(".")[1]?.length ?? 0));
      // out × rate >= local, and (out - 1) × rate < local (tight)
      expect(out * fixed * 10n ** 18n).toBeGreaterThanOrEqual(localE * 10n ** 6n * 10n ** BigInt(RATE_DECIMALS));
      expect((out - 1n) * fixed * 10n ** 18n).toBeLessThan(localE * 10n ** 6n * 10n ** BigInt(RATE_DECIMALS));
    }
  });

  it("rate conversion: float once to 8-decimal fixed point, rounded down; garbage refused", () => {
    expect(rateToFixed(1650)).toBe(165_000_000_000n);
    expect(rateToFixed(1650.123456789)).toBe(165_012_345_678n);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(rateToFixed(bad)).toBeNull();
    const fixed = localPerUsdFixed({ ARS: 1 / 1650 }, "ARS")!;
    expect(fixed >= 164_999_999_999n && fixed <= 165_000_000_000n).toBe(true);
    expect(localPerUsdFixed({ USD: 1 }, "ARS")).toBeNull();
  });

  it("quoteUsdt refuses without a fresh rate (missing currency, throwing source, no source)", async () => {
    expect(await quoteUsdt("4500", "ARS", NO_RATES)).toEqual({ ok: false, error: "rate_unavailable" });
    expect(await quoteUsdt("4500", "ARS", async () => Promise.reject(new Error("down")))).toEqual({ ok: false, error: "rate_unavailable" });
    expect(await quoteUsdt("4500", "ARS", undefined)).toEqual({ ok: false, error: "rate_unavailable" });
    expect(await quoteUsdt("4500", "ARS", RATES)).toMatchObject({ ok: true, amountOut: 2_727_273n });
  });

  it("display: rounded up to cents in the merchant's style", () => {
    expect(formatUsdCents(2_727_273n, 6, "comma")).toBe("2,73");
    expect(formatUsdCents(1_000_000n, 6, "dot")).toBe("1.00");
    expect(formatUsdCents(1_234_567_890n, 6, "comma")).toBe("1.234,57");
  });
});

describe("USD₮ invoices", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("createInvoice: local amount kept, amountOut in USD₮ at the injected rate; no rate -> nothing created", async () => {
    const m = await seedMerchant(db, { telegramUserId: 1n, settlementToken: USDT.address });
    const res = await createInvoice(db, m, { amountLocal: "4500", now: NOW, rates: RATES });
    expect(res.ok && res.invoice).toMatchObject({ amountLocal: "4500", currency: "ARS", tokenOut: USDT.address, amountOut: "2727273" });
    expect(await createInvoice(db, m, { amountLocal: "4500", now: NOW, rates: NO_RATES })).toEqual({ ok: false, error: "rate_unavailable" });
    expect(await createInvoice(db, m, { amountLocal: "4500", now: NOW })).toEqual({ ok: false, error: "rate_unavailable" });
    expect(await db.select().from(invoices)).toHaveLength(1);
  });

  it("bot: caption shows local ≈ USD₮; missing rate -> translated refusal, no invoice", async () => {
    await seedMerchant(db, { telegramUserId: 5n, settlementToken: USDT.address });
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW, rates: RATES });
    await bot.handleUpdate(textUpdate(5, "cobrar 4500 café"));
    expect(sent(calls, "sendPhoto").at(-1)!.payload.caption).toMatch(/^Cobro A-0001: \$ 4\.500 ARS ≈ 2,73 USD₮ — café/);

    const { bot: bot2, calls: calls2 } = makeBot(db, { model: forbiddenModel(), now: () => NOW, rates: NO_RATES });
    await bot2.handleUpdate(textUpdate(5, "cobrar 100"));
    expect(texts(calls2).at(-1)).toBe(t("es", "rate_unavailable", { currency: "ARS" }));
    expect(await db.select().from(invoices)).toHaveLength(1);
  });

  it("paid notification and daily CSV read the invoice's own tokenOut / amountOut", async () => {
    const m = await seedMerchant(db, { telegramUserId: 6n, settlementToken: USDT.address });
    const res = await createInvoice(db, m, { amountLocal: "4500", now: NOW, rates: RATES });
    if (!res.ok) throw new Error("no invoice");
    const api = new Api("123:fake");
    const calls = fakeApi(api);
    await createNotifierWithApi(api, db).invoicePaid({
      merchantId: m.id, invoiceId: res.invoice.id as Hex, amountLocal: "4500", currency: "ARS", reference: "A-0001", txHash: `0x${"ab".repeat(32)}` as Hex,
    });
    expect(texts(calls)[0]).toContain("$ 4.500 ARS → 2,727273 USD₮ en tu billetera");

    const s = await dailySummary(db, m, "2026-11-02");
    expect(s.csv.split("\r\n")[1]).toMatch(/,4500,ARS,.*,2\.727273,USDT$/);
  });
});

describe("settings commands: /moneda, /pais, /billetera", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("/moneda offers exactly the local wFIAT and USD₮, and persists the choice", async () => {
    const m = await seedMerchant(db, { telegramUserId: 10n });
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW });
    await bot.handleUpdate(textUpdate(10, "/moneda"));
    const kb = lastKeyboard(calls);
    expect(kb).toContain("wARS · pesos digitales");
    expect(kb).toContain("USD₮ · dólares digitales");
    expect(kb.match(/cur:/g)).toHaveLength(2);

    await bot.handleUpdate(callbackUpdate(10, "cur:usd"));
    expect((await getMerchant(db, m.id))!.settlementToken).toBe(USDT.address);
    expect(texts(calls).at(-1)).toBe("Listo: recibirás USD₮. Tus cobros siguen en ARS.");
    await bot.handleUpdate(callbackUpdate(10, "cur:local"));
    expect((await getMerchant(db, m.id))!.settlementToken).toBe(WARS.address);
  });

  it("set_preferences.settlement_token accepts only the local wFIAT or USDT", async () => {
    const merchant = await seedMerchant(db, { telegramUserId: 11n });
    const ctx: ToolContext = { db, merchant, publicBaseUrl: BASE_URL, now: () => NOW, env: {} };
    const tools = buildTools(ctx, newEffects());
    const call = (input: unknown) => (tools.set_preferences.execute as (i: unknown, o: unknown) => Promise<any>)(input, { toolCallId: "t", messages: [] });
    for (const bad of ["wBRL", "USDC", "USAT", "cUSD", "ETH"]) {
      expect((await call({ settlement_token: bad })).settlement_token).toMatchObject({ ok: false, error: "unsupported", supported: ["wARS", "USDT"] });
    }
    expect((await getMerchant(db, merchant.id))!.settlementToken).toBe(WARS.address);
    expect((await call({ settlement_token: "usdt" })).settlement_token).toEqual({ ok: true, value: "USDT" });
    expect((await getMerchant(db, merchant.id))!.settlementToken).toBe(USDT.address);
    expect((await call({ settlement_token: "wARS" })).settlement_token).toEqual({ ok: true, value: "wARS" });
    expect((await getMerchant(db, merchant.id))!.settlementToken).toBe(WARS.address);
  });

  it("/pais: country, currency, wFIAT, timezone and amount style follow; payout kept; stale open requests can be cancelled", async () => {
    const m = await seedMerchant(db, { telegramUserId: 12n });
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW });
    await bot.handleUpdate(textUpdate(12, "cobrar 4500 café")); // open ARS request
    await bot.handleUpdate(textUpdate(12, "/pais"));
    expect(texts(calls).at(-1)).toMatch(/Ahora: Argentina \(ARS\)/);
    expect(lastKeyboard(calls)).toContain("country:MX");

    await bot.handleUpdate(callbackUpdate(12, "country:MX"));
    const fresh = (await getMerchant(db, m.id))!;
    expect(fresh).toMatchObject({
      country: "MX", currency: "MXN", settlementToken: tokenBySymbol("wMXN")!.address, timezone: "America/Mexico_City", payoutAddress: ADDR_A,
    });
    const all = texts(calls);
    expect(all.some((x) => x.startsWith("Listo: México. Cobras en MXN y recibes wMXN"))).toBe(true);
    expect(all.at(-1)).toBe("1 cobro(s) abierto(s) todavía pagan a la dirección o moneda anterior.");
    expect(lastKeyboard(calls)).toContain("sx:all");

    await bot.handleUpdate(callbackUpdate(12, "sx:all"));
    expect(texts(calls).at(-1)).toBe("1 cobro(s) cancelado(s).");
    const [old] = await db.select().from(invoices).where(eq(invoices.merchantId, m.id));
    expect(old!.status).toBe("cancelled");

    await bot.handleUpdate(textUpdate(12, "cobrar 1,500.50 tacos")); // MX: dot decimals
    const rows = await db.select().from(invoices).where(eq(invoices.status, "open"));
    expect(rows.map((r) => [r.amountLocal, r.currency])).toEqual([["1500.5", "MXN"]]);
  });

  it("/país (accented text alias) shows the country buttons; a USD₮ merchant stays in USD₮", async () => {
    const m = await seedMerchant(db, { telegramUserId: 13n, settlementToken: USDT.address });
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW });
    await bot.handleUpdate(textUpdate(13, "/país"));
    expect(lastKeyboard(calls)).toContain("country:BR");
    await bot.handleUpdate(callbackUpdate(13, "country:BR"));
    expect(await getMerchant(db, m.id)).toMatchObject({ country: "BR", currency: "BRL", settlementToken: USDT.address });
    expect(texts(calls).some((x) => x.includes("recibes USD₮"))).toBe(true);
  });

  it("/billetera 0x…: validated, then the existing po:/pn: confirmation; confirm warns about stale open requests", async () => {
    const m = await seedMerchant(db, { telegramUserId: 14n, payoutAddressProven: 1 });
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW });
    await bot.handleUpdate(textUpdate(14, "/billetera 0x123"));
    expect(texts(calls).at(-1)).toMatch(/no parece una dirección válida/);
    await bot.handleUpdate(textUpdate(14, `/billetera 0x${"11".repeat(32)}`));
    expect(texts(calls).at(-1)).toMatch(/NUNCA la compartas/);

    await bot.handleUpdate(textUpdate(14, "cobrar 100"));
    await bot.handleUpdate(textUpdate(14, `/billetera ${ADDR_B}`));
    expect(texts(calls).at(-1)).toContain(ADDR_B);
    const nonce = /po:([0-9a-f]{12})/.exec(lastKeyboard(calls))![1];
    expect((await getMerchant(db, m.id))!.payoutAddress).toBe(ADDR_A); // not before the tap

    await bot.handleUpdate(callbackUpdate(14, `po:${nonce}`));
    expect(await getMerchant(db, m.id)).toMatchObject({ payoutAddress: ADDR_B, payoutAddressProven: 0 });
    const all = texts(calls);
    expect(all.at(-2)).toBe(`Dirección de cobro actualizada: ${ADDR_B}`);
    expect(all.at(-1)).toBe("1 cobro(s) abierto(s) todavía pagan a la dirección o moneda anterior.");
  });

  it("/billetera alone: next message is the address (invalid / secret refused, never sent to the LLM); pn: rejects", async () => {
    const m = await seedMerchant(db, { telegramUserId: 15n });
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW });
    await bot.handleUpdate(textUpdate(15, "/billetera"));
    expect(texts(calls).at(-1)).toBe(t("es", "ask_wallet"));
    await bot.handleUpdate(textUpdate(15, "mi billetera"));
    expect(texts(calls).at(-1)).toMatch(/no parece una dirección válida/);
    await bot.handleUpdate(textUpdate(15, "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"));
    expect(texts(calls).at(-1)).toMatch(/NUNCA la compartas/);
    await bot.handleUpdate(textUpdate(15, ADDR_B.toLowerCase()));
    const nonce = /pn:([0-9a-f]{12})/.exec(lastKeyboard(calls))![1];
    await bot.handleUpdate(callbackUpdate(15, `pn:${nonce}`));
    expect(texts(calls).at(-1)).toBe(t("es", "payout_rejected"));
    expect((await getMerchant(db, m.id))!.payoutAddress).toBe(ADDR_A);

    // the awaiting state was consumed: plain text goes back to the normal flow (LLM disabled here)
    const { bot: bot2, calls: calls2 } = makeBot(db, { model: null, now: () => NOW });
    await bot2.handleUpdate(textUpdate(15, "hola"));
    expect(texts(calls2).at(-1)).toBe(t("es", "llm_unavailable"));
  });

  it("language change sets the per-chat command menu in the chosen language; a menu failure never breaks the reply", async () => {
    await seedMerchant(db, { telegramUserId: 16n });
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW });
    await bot.handleUpdate(callbackUpdate(16, "lang:en"));
    const menu = sent(calls, "setMyCommands").at(-1)!.payload;
    expect(menu.scope).toEqual({ type: "chat", chat_id: 16 });
    expect((menu.commands as Array<{ command: string }>).map((c) => c.command)).toEqual(
      expect.arrayContaining(["charge", "country", "currency", "wallet", "help"]),
    );
    expect(texts(calls).at(-1)).toBe(t("en", "language_set"));

    const { bot: bot2, calls: calls2, logs } = makeBot(db, { model: forbiddenModel(), now: () => NOW });
    bot2.api.config.use(async (prev, method, payload, signal) => {
      if (method === "setMyCommands") throw new Error("telegram down");
      return prev(method, payload, signal);
    });
    await bot2.handleUpdate(callbackUpdate(16, "lang:pt"));
    expect(texts(calls2).at(-1)).toBe(t("pt", "language_set"));
    expect(logs.some((l) => l.msg === "chat_menu_error")).toBe(true);
  });

  it("onboarding completion sets the chat menu in the onboarding language", async () => {
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW });
    await bot.handleUpdate(textUpdate(17, "/start", { language_code: "pt-BR" }));
    await bot.handleUpdate(callbackUpdate(17, "country:BR"));
    await bot.handleUpdate(textUpdate(17, ADDR_A));
    const menu = sent(calls, "setMyCommands").at(-1)!.payload;
    expect(menu.scope).toEqual({ type: "chat", chat_id: 17 });
    expect((menu.commands as Array<{ command: string }>).map((c) => c.command)).toContain("carteira");
  });

  it("help and command menus list the 3 new commands in es / pt / en", async () => {
    expect(t("es", "help", { token: "wARS" })).toMatch(/\/pais[\s\S]*\/moneda[\s\S]*\/billetera/);
    expect(t("pt", "help", { token: "wBRL" })).toMatch(/\/pais[\s\S]*\/moeda[\s\S]*\/carteira/);
    expect(t("en", "help", { token: "wARS" })).toMatch(/\/country[\s\S]*\/currency[\s\S]*\/wallet/);
    const api = new Api("123:fake");
    const calls = fakeApi(api);
    await registerBotCommands(api);
    const byLang = new Map(calls.map((c) => [c.payload.language_code ?? "es", (c.payload.commands as Array<{ command: string }>).map((x) => x.command)]));
    expect(byLang.get("es")).toEqual(expect.arrayContaining(["pais", "moneda", "billetera"]));
    expect(byLang.get("pt")).toEqual(expect.arrayContaining(["pais", "moeda", "carteira"]));
    expect(byLang.get("en")).toEqual(expect.arrayContaining(["country", "currency", "wallet"]));
  });
});
