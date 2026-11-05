/** Unit clarity: currency written out, dollar hint, per-payment cap refusal and large-charge confirmation. */
import { beforeEach, describe, expect, it } from "vitest";
import { FLAG_KEYS, invoices, setFlag, type Db } from "@cobra/db";
import { buildTools, newEffects, type ToolContext } from "../src/agent";
import { formatAmountNamed } from "../src/amount";
import { t } from "../src/i18n";
import { createInvoice } from "../src/invoices";
import { chargeSize } from "../src/limits";
import { callbackUpdate, createTestDb, forbiddenModel, makeBot, seedMerchant, sent, textUpdate, texts } from "./helpers";

const NOW = new Date("2026-11-02T15:00:00.000Z");
const RATES = async () => ({ USD: 1, ARS: 1 / 1650, BRL: 1 / 5.4 });
const NO_RATES = async () => ({ USD: 1 });

type Calls = ReturnType<typeof makeBot>["calls"];
const buttons = (calls: Calls): Array<{ text: string; callback_data: string }> =>
  ((sent(calls, "sendMessage").at(-1)!.payload.reply_markup as { inline_keyboard?: unknown[][] } | undefined)?.inline_keyboard ?? []).flat() as Array<{
    text: string;
    callback_data: string;
  }>;

describe("currency written out", () => {
  it("formats with the currency name in each language", () => {
    expect(formatAmountNamed("4500", "ARS", "comma", "es")).toBe("$ 4.500 pesos argentinos");
    expect(formatAmountNamed("30", "BRL", "comma", "pt")).toBe("R$ 30 reais");
    expect(formatAmountNamed("4500", "MXN", "dot", "en")).toBe("$ 4,500 Mexican pesos");
    expect(formatAmountNamed("4500", "COP", "comma", "es")).toBe("$ 4.500 pesos colombianos");
  });

  it("help, usage and the foreign-currency refusal name the merchant's currency", async () => {
    const db = await createTestDb();
    await seedMerchant(db, { telegramUserId: 1n });
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW });
    await bot.handleUpdate(textUpdate(1, "/ayuda"));
    expect(texts(calls).at(-1)).toMatch(/^Comandos \(los montos son en pesos argentinos\):\n\/cobrar 4500 café — crea un cobro de 4500 pesos argentinos/);
    await bot.handleUpdate(textUpdate(1, "/cobrar"));
    expect(texts(calls).at(-1)).toBe("Escribe el monto en pesos argentinos y una descripción, por ejemplo: cobrar 4500 café");
    await bot.handleUpdate(textUpdate(1, "cobrar 10 dólares"));
    expect(texts(calls).at(-1)).toMatch(/^Tus cobros son en pesos argentinos\..*\/moneda/);
    expect(await db.select().from(invoices)).toHaveLength(0);
  });
});

describe("charge size (dollar value vs the per-payment cap)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("classifies at the reference rate: confirm from half the cap, refuse above the cap, unknown without a rate", async () => {
    // 1650 ARS = 1 USD; default cap US$ 200 -> confirm from 165.000 ARS, refuse above 330.000 ARS.
    expect((await chargeSize(db, "164999", "ARS", RATES)).kind).toBe("ok");
    expect((await chargeSize(db, "165000", "ARS", RATES)).kind).toBe("confirm");
    expect((await chargeSize(db, "330000", "ARS", RATES)).kind).toBe("confirm");
    expect((await chargeSize(db, "330000.01", "ARS", RATES)).kind).toBe("over");
    expect(await chargeSize(db, "999999", "ARS", NO_RATES)).toEqual({ kind: "unknown" });
    expect(await chargeSize(db, "999999", "ARS", async () => Promise.reject(new Error("down")))).toEqual({ kind: "unknown" });
  });

  it("follows the operator's cap flag", async () => {
    await setFlag(db, FLAG_KEYS.caps, { perPaymentUsd: 50, perDayUsd: 2000 });
    expect(await chargeSize(db, "100000", "ARS", RATES)).toMatchObject({ kind: "over", maxUsd: 50 });
  });

  it("createInvoice: over the cap -> over_limit, large -> needs_confirmation unless confirmed, no rate -> not blocked", async () => {
    const m = await seedMerchant(db, { telegramUserId: 1n });
    expect(await createInvoice(db, m, { amountLocal: "500000", now: NOW, rates: RATES })).toMatchObject({ ok: false, error: "over_limit" });
    expect(await createInvoice(db, m, { amountLocal: "200000", now: NOW, rates: RATES })).toMatchObject({ ok: false, error: "needs_confirmation" });
    expect(await db.select().from(invoices)).toHaveLength(0);
    expect(await createInvoice(db, m, { amountLocal: "200000", now: NOW, rates: RATES, confirmed: true })).toMatchObject({ ok: true });
    expect(await createInvoice(db, m, { amountLocal: "500000", now: NOW, rates: RATES, confirmed: true })).toMatchObject({ ok: false, error: "over_limit" });
    expect(await createInvoice(db, m, { amountLocal: "500000", now: NOW, rates: NO_RATES })).toMatchObject({ ok: true });
  });

  it("bot: small charge gets the dollar hint; above the cap is refused with the dollar value", async () => {
    await seedMerchant(db, { telegramUserId: 1n });
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW, rates: RATES });
    await bot.handleUpdate(textUpdate(1, "cobrar 4500 café"));
    expect(sent(calls, "sendPhoto").at(-1)!.payload.caption).toMatch(/^Cobro A-0001: \$ 4\.500 pesos argentinos \(≈ US\$ 2,73\) — café\n/);

    await bot.handleUpdate(textUpdate(1, "cobrar 500000 tele"));
    expect(texts(calls).at(-1)).toBe(
      "No creé el cobro: $ 500.000 pesos argentinos equivale a ≈ US$ 303,04, y por ahora el máximo por pago es US$ 200. ¿Escribiste el monto en pesos argentinos? Revísalo y vuelve a intentarlo.",
    );
    expect(await db.select().from(invoices)).toHaveLength(1);
  });

  it("bot: a large charge waits for 'yes'; 'fix' creates nothing; a used or foreign button is refused", async () => {
    await seedMerchant(db, { telegramUserId: 1n });
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW, rates: RATES });

    await bot.handleUpdate(textUpdate(1, "cobrar 200000 heladera"));
    expect(texts(calls).at(-1)).toBe("¿Confirmas este cobro?\n$ 200.000 pesos argentinos (≈ US$ 121,22) — heladera");
    const [yes, fix] = buttons(calls);
    expect(yes).toMatchObject({ text: "Sí, cobrar" });
    expect(fix).toMatchObject({ text: "Corregir" });
    expect(await db.select().from(invoices)).toHaveLength(0);

    await bot.handleUpdate(callbackUpdate(1, yes!.callback_data));
    expect(sent(calls, "sendPhoto").at(-1)!.payload.caption).toMatch(/^Cobro A-0001: \$ 200\.000 pesos argentinos \(≈ US\$ 121,22\) — heladera\n/);
    expect(await db.select().from(invoices)).toHaveLength(1);

    await bot.handleUpdate(callbackUpdate(1, yes!.callback_data)); // double tap
    expect(texts(calls).at(-1)).toBe(t("es", "charge_confirm_expired"));
    expect(await db.select().from(invoices)).toHaveLength(1);

    await bot.handleUpdate(textUpdate(1, "cobrar 250000"));
    const [, fix2] = buttons(calls);
    await bot.handleUpdate(callbackUpdate(1, fix2!.callback_data));
    expect(texts(calls).at(-1)).toBe("Listo, no creé nada. Escribe el monto correcto en pesos argentinos, por ejemplo: cobrar 4500 café");
    expect(await db.select().from(invoices)).toHaveLength(1);

    // Another merchant cannot use this merchant's pending confirmation.
    await seedMerchant(db, { telegramUserId: 2n });
    await bot.handleUpdate(textUpdate(1, "cobrar 180000"));
    const [yes3] = buttons(calls);
    await bot.handleUpdate(callbackUpdate(2, yes3!.callback_data));
    expect(texts(calls).at(-1)).toBe(t("es", "charge_confirm_expired"));
    expect(await db.select().from(invoices)).toHaveLength(1);
  });

  it("agent create_invoice: a large amount becomes a confirmation effect, never an invoice", async () => {
    const merchant = await seedMerchant(db, { telegramUserId: 1n });
    const ctx: ToolContext = { db, merchant, publicBaseUrl: "https://cobra.test", now: () => NOW, env: {}, rates: RATES };
    const effects = newEffects();
    const tools = buildTools(ctx, effects);
    const out = await (tools.create_invoice.execute as (i: unknown, o: unknown) => Promise<any>)({ amount: "200.000", description: "heladera" }, { toolCallId: "t", messages: [] });
    expect(out).toMatchObject({ ok: false, error: "needs_confirmation" });
    expect(effects.invoices).toHaveLength(0);
    expect(effects.chargeConfirmation).toMatchObject({ pending: { amountLocal: "200000", description: "heladera" } });
    expect(await db.select().from(invoices)).toHaveLength(0);
  });
});
