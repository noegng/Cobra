import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { InputFile } from "grammy";
import { invoices, merchants, type Db } from "@cobra/db";
import { tokenBySymbol } from "@cobra/shared";
import { findMerchantByTelegramId } from "../src/merchants";
import {
  ADDR_A,
  BASE_URL,
  callbackUpdate,
  createTestDb,
  forbiddenModel,
  makeBot,
  seedMerchant,
  sent,
  textUpdate,
  texts,
  voiceUpdate,
} from "./helpers";

const NOW = new Date("2026-11-02T15:00:00.000Z");

describe("bot update handling (grammY, fake API transformer)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("onboarding in ~4 messages: /start (pt from language_code) -> country -> address checks -> static QR", async () => {
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW });
    await bot.handleUpdate(textUpdate(7, "/start", { language_code: "pt-BR" }));
    expect(texts(calls)[0]).toMatch(/^Olá! Eu sou o Cobrá/);
    const kb = JSON.stringify(sent(calls, "sendMessage")[0]!.payload.reply_markup);
    for (const c of ["AR", "BR", "MX", "CO", "CL", "PE"]) expect(kb).toContain(`country:${c}`);
    expect(kb).toContain("lang:en");

    await bot.handleUpdate(callbackUpdate(7, "country:BR"));
    expect(sent(calls, "answerCallbackQuery").length).toBeGreaterThan(0);
    expect(texts(calls).at(-1)).toMatch(/Passo 2 de 2.*wBRL/s);

    await bot.handleUpdate(textUpdate(7, "minha carteira"));
    expect(texts(calls).at(-1)).toMatch(/não parece um endereço válido/);
    await bot.handleUpdate(textUpdate(7, "0x70997970c51812dc3a010c7d01b50e0d17dc79C8")); // bad checksum
    expect(texts(calls).at(-1)).toMatch(/checksum/);
    await bot.handleUpdate(textUpdate(7, `0x${"11".repeat(32)}`)); // looks like a private key
    expect(texts(calls).at(-1)).toMatch(/NUNCA compartilhe/);
    expect(await findMerchantByTelegramId(db, 7)).toBeNull();

    await bot.handleUpdate(textUpdate(7, ADDR_A.toLowerCase()));
    const m = await findMerchantByTelegramId(db, 7);
    expect(m).toMatchObject({
      country: "BR", currency: "BRL", language: "pt", payoutAddress: ADDR_A, settlementToken: tokenBySymbol("wBRL")!.address,
      timezone: "America/Sao_Paulo", telegramChatId: 7n, payoutAddressProven: 0,
    });
    expect(m!.staticSlug).toMatch(/^ana-[a-z2-9]{5}$/);
    const photo = sent(calls, "sendPhoto").at(-1)!;
    expect(photo.payload.photo).toBeInstanceOf(InputFile);
    expect(photo.payload.caption).toBe(`Seu QR de cobrança fixo: ${BASE_URL}/pay/m/${m!.staticSlug}`);
    expect(texts(calls).some((t) => t.includes(`/m/${m!.staticSlug}/verify`))).toBe(true);

    await bot.handleUpdate(textUpdate(7, "/start"));
    expect(texts(calls).at(-1)).toMatch(/Olá de novo, Ana/);
  });

  it("MX onboards with direct wFIAT settlement and a no-conversion notice; language can be changed mid-onboarding", async () => {
    const { bot, calls } = makeBot(db, { now: () => NOW });
    await bot.handleUpdate(textUpdate(8, "/start", { language_code: "fr" })); // unknown -> es
    expect(texts(calls)[0]).toMatch(/^¡Hola!/);
    await bot.handleUpdate(callbackUpdate(8, "lang:en"));
    expect(texts(calls)).toContain("Done, I'll speak English.");
    await bot.handleUpdate(callbackUpdate(8, "country:MX"));
    expect(texts(calls).some((t) => t.includes("no automatic conversion in Mexico") && t.includes("wMXN"))).toBe(true);
    await bot.handleUpdate(textUpdate(8, ADDR_A));
    const m = await findMerchantByTelegramId(db, 8);
    expect(m).toMatchObject({ country: "MX", currency: "MXN", language: "en", settlementToken: tokenBySymbol("wMXN")!.address });
  });

  it("fast path 'cobrar 4500 café' creates the invoice without the LLM and sends QR + WhatsApp share + cancel button", async () => {
    await seedMerchant(db, { telegramUserId: 1n });
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW });
    await bot.handleUpdate(textUpdate(1, "cobrar 4.500,50 café con leche"));

    const [inv] = await db.select().from(invoices);
    expect(inv).toMatchObject({ amountLocal: "4500.5", description: "café con leche", reference: "A-0001", source: "chat" });
    const photo = sent(calls, "sendPhoto")[0]!;
    expect(photo.payload.caption).toBe(
      `Cobro A-0001: $ 4.500,50 — café con leche\nVence en 10 min.\nLink de pago: ${BASE_URL}/pay/${inv!.id}`,
    );
    const buttons = photo.payload.reply_markup.inline_keyboard.flat();
    const wa = buttons.find((b: any) => String(b.url ?? "").startsWith("https://wa.me/?text="));
    expect(decodeURIComponent(wa.url.split("text=")[1])).toBe(
      `Kiosco Ana te envía un cobro de $ 4.500,50 (café con leche). Paga aquí: ${BASE_URL}/pay/${inv!.id}`,
    );
    expect(buttons.some((b: any) => b.url === `${BASE_URL}/pay/${inv!.id}`)).toBe(true);
    expect(buttons.some((b: any) => b.callback_data === "cx:A-0001")).toBe(true);
    expect(calls.map((c) => c.method)).not.toContain("sendChatAction"); // LLM path not entered

    await bot.handleUpdate(callbackUpdate(1, "cx:A-0001"));
    expect(texts(calls).at(-1)).toBe("Cobro A-0001 cancelado.");
    const [after] = await db.select().from(invoices);
    expect(after!.status).toBe("cancelled");
  });

  it("/cobrar command variants and amount errors are answered deterministically", async () => {
    await seedMerchant(db, { telegramUserId: 1n });
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW });
    await bot.handleUpdate(textUpdate(1, "/cobrar"));
    expect(texts(calls).at(-1)).toMatch(/Escribe el monto/);
    await bot.handleUpdate(textUpdate(1, "/cobrar 4,500 algo"));
    expect(texts(calls).at(-1)).toMatch(/"4,500" es ambiguo/);
    await bot.handleUpdate(textUpdate(1, "cobrar US$ 10 algo"));
    expect(texts(calls).at(-1)).toMatch(/solo cobro en ARS/);
    await bot.handleUpdate(textUpdate(1, "/cobrar 2 mil pizza"));
    const [inv] = await db.select().from(invoices);
    expect(inv!.amountLocal).toBe("2000");
  });

  it("/facturas, /cierre (+CSV), /retirar (manual, no RIPIO_PARTNER), /ayuda, /idioma", async () => {
    const m = await seedMerchant(db, { telegramUserId: 1n });
    const { bot, calls } = makeBot(db, { now: () => NOW });
    await bot.handleUpdate(textUpdate(1, "/facturas"));
    expect(texts(calls).at(-1)).toBe("Todavía no tienes cobros.");
    await bot.handleUpdate(textUpdate(1, "cobrar 100 agua"));
    await bot.handleUpdate(textUpdate(1, "cobrar 250 alfajor"));
    await db.update(invoices).set({ status: "paid", paidAt: NOW }).where(eq(invoices.reference, "A-0001"));
    await bot.handleUpdate(textUpdate(1, "/facturas"));
    expect(texts(calls).at(-1)).toBe("Tus últimos cobros:\nA-0002 · $ 250 · pendiente · alfajor\nA-0001 · $ 100 · pagado · agua");

    await bot.handleUpdate(textUpdate(1, "/cierre"));
    expect(texts(calls).at(-1)).toMatch(/Cierre del día 2026-11-02\nCobrado: \$ 100 \(1 pagos\)/);
    const doc = sent(calls, "sendDocument").at(-1)!;
    expect(doc.payload.document).toBeInstanceOf(InputFile);
    expect(doc.payload.caption).toBe("Detalle del día 2026-11-02 (CSV)");

    await bot.handleUpdate(textUpdate(1, "/retirar"));
    expect(texts(calls).at(-1)).toMatch(/Ripio.*red Celo.*nunca mueve tus fondos/s);
    expect(texts(calls).at(-1)).not.toMatch(/https?:\/\//);

    await bot.handleUpdate(textUpdate(1, "/ayuda"));
    expect(texts(calls).at(-1)).toMatch(/\/cobrar 4500 café/);
    await bot.handleUpdate(textUpdate(1, "/idioma"));
    await bot.handleUpdate(callbackUpdate(1, "lang:pt"));
    const [fresh] = await db.select().from(merchants).where(eq(merchants.id, m.id));
    expect(fresh!.language).toBe("pt");
    await bot.handleUpdate(textUpdate(1, "/faturas"));
    expect(texts(calls).at(-1)).toMatch(/^Suas últimas cobranças:/);
  });

  it("/retirar returns the Ripio widget link only when RIPIO_PARTNER and a session minter exist", async () => {
    await seedMerchant(db, { telegramUserId: 1n });
    const { bot, calls } = makeBot(db, { env: { RIPIO_PARTNER: "cobra" }, ripio: { mint: async () => "tok" } });
    await bot.handleUpdate(textUpdate(1, "/retirar"));
    expect(texts(calls).at(-1)).toContain("https://b2b-widget-onramp.ripio.com/offramp.html?_to=tok&_la=es");
  });

  it("non-onboarded users, groups and other merchants' callbacks are handled safely", async () => {
    await seedMerchant(db, { telegramUserId: 1n });
    const { bot, calls } = makeBot(db, { model: forbiddenModel(), now: () => NOW });
    await bot.handleUpdate(textUpdate(1, "cobrar 100 agua"));

    await bot.handleUpdate(textUpdate(2, "cobrar 100 agua"));
    expect(texts(calls).at(-1)).toBe("Primero configuremos tu cuenta: /start");
    await bot.handleUpdate(callbackUpdate(2, "cx:A-0001")); // not a merchant: ignored
    const before = calls.length;
    await bot.handleUpdate(textUpdate(1, "cobrar 100 agua", { chatType: "group" }));
    expect(calls.length).toBe(before); // groups ignored entirely

    const other = await seedMerchant(db, { telegramUserId: 3n });
    await bot.handleUpdate(callbackUpdate(3, "cx:A-0001")); // merchant 3 has no A-0001
    expect(texts(calls).at(-1)).toBe("No encontré ese cobro.");
    const rows = await db.select().from(invoices);
    expect(rows.filter((r) => r.status === "cancelled")).toHaveLength(0);
    expect(other.id).not.toBe(rows[0]!.merchantId);
  });

  it("free text without an LLM key falls back to a deterministic hint", async () => {
    await seedMerchant(db, { telegramUserId: 1n });
    const { bot, calls } = makeBot(db, { model: null });
    await bot.handleUpdate(textUpdate(1, "¿me pagaron el último?"));
    expect(texts(calls).at(-1)).toMatch(/Solo entiendo comandos simples/);
  });

  it("voice note: downloads the file, transcribes, then takes the fast path", async () => {
    await seedMerchant(db, { telegramUserId: 1n });
    const fetched: string[] = [];
    const transcribe = async (audio: ArrayBuffer, mime: string) => {
      expect(new Uint8Array(audio)).toEqual(new Uint8Array([1, 2, 3]));
      expect(mime).toBe("audio/ogg");
      return "cobrar 3 mil corte de pelo";
    };
    const { bot, calls } = makeBot(
      db,
      {
        model: forbiddenModel(),
        now: () => NOW,
        fetchFile: async (url) => {
          fetched.push(url);
          return new Uint8Array([1, 2, 3]).buffer;
        },
      },
      transcribe,
    );
    await bot.handleUpdate(voiceUpdate(1));
    expect(sent(calls, "getFile")[0]!.payload.file_id).toBe("voice-1");
    expect(fetched).toEqual(["https://api.telegram.org/file/bot123456:TEST-TOKEN/voice/file_1.oga"]);
    expect(texts(calls)[0]).toBe('Entendí: "cobrar 3 mil corte de pelo"');
    const [inv] = await db.select().from(invoices);
    expect(inv).toMatchObject({ amountLocal: "3000", description: "corte de pelo" });

    await bot.handleUpdate(voiceUpdate(1, 120));
    expect(texts(calls).at(-1)).toMatch(/muy largo/);
  });

  it("voice note without a transcriber gets a polite reply", async () => {
    await seedMerchant(db, { telegramUserId: 1n });
    const { bot, calls } = makeBot(db);
    await bot.handleUpdate(voiceUpdate(1));
    expect(texts(calls).at(-1)).toMatch(/no puedo escuchar audios/);
  });
});
