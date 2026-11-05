import { beforeEach, describe, expect, it } from "vitest";
import { Api, InputFile } from "grammy";
import { eq } from "drizzle-orm";
import { flags, invoices, type Db } from "@cobra/db";
import type { Hex } from "viem";
import { createWebhookHandler, runDailyClose, runReminders } from "../src/index";
import { createInvoice } from "../src/invoices";
import { createNotifierWithApi } from "../src/notifier";
import { createGroqTranscriber, groqTranscriberFromEnv, GROQ_TRANSCRIPTION_URL } from "../src/transcribe-groq";
import { BASE_URL, BOT_INFO, createTestDb, fakeApi, seedMerchant, sent, TOKEN, texts } from "./helpers";

const T0 = new Date("2026-11-02T15:00:00.000Z"); // 12:00 Buenos Aires

function notifierFor(db: Db) {
  const api = new Api(TOKEN);
  const calls = fakeApi(api);
  return { notifier: createNotifierWithApi(api, db), calls };
}

describe("notifier", () => {
  it("invoicePaid sends a localized message with the Celoscan link to the merchant's chat", async () => {
    const db = await createTestDb();
    const m = await seedMerchant(db, { telegramUserId: 42n, country: "BR" });
    const { notifier, calls } = notifierFor(db);
    const txHash = `0x${"cd".repeat(32)}` as Hex;
    await notifier.invoicePaid({ merchantId: m.id, invoiceId: `0x${"11".repeat(32)}`, amountLocal: "30", currency: "BRL", reference: "A-0007", txHash });
    expect(sent(calls, "sendMessage")[0]!.payload.chat_id).toBe(42);
    expect(texts(calls)[0]).toBe(`Pagamento recebido! A-0007: R$ 30 reais → 30 wBRL na sua carteira.\nComprovante: https://celoscan.io/tx/${txHash}`);
    await notifier.text(m.id, "hola");
    await notifier.document(m.id, { filename: "x.csv", content: "a,b\r\n" }, "cap");
    expect(sent(calls, "sendDocument")[0]!.payload.document).toBeInstanceOf(InputFile);
    await expect(notifier.text("00000000-0000-0000-0000-000000000000", "x")).rejects.toThrow(/unknown merchant/);
  });
});

describe("runReminders", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("reminds once per open chat invoice in the last minutes before expiry, with the WhatsApp share link", async () => {
    const m = await seedMerchant(db, { telegramUserId: 1n });
    const r = await createInvoice(db, m, { amountLocal: "4500", description: "café", now: T0 });
    const inv = r.ok ? r.invoice : null;
    const paidOne = await createInvoice(db, m, { amountLocal: "10", now: T0 });
    if (paidOne.ok) await db.update(invoices).set({ status: "paid" }).where(eq(invoices.id, paidOne.invoice.id));
    const staticOne = await createInvoice(db, m, { amountLocal: "20", now: T0 });
    if (staticOne.ok) await db.update(invoices).set({ source: "static_qr" }).where(eq(invoices.id, staticOne.invoice.id));
    const { notifier, calls } = notifierFor(db);

    await runReminders({ db, notifier, now: new Date(T0.getTime() + 5 * 60_000), publicBaseUrl: BASE_URL }); // 5 min left
    expect(texts(calls)).toHaveLength(0);

    const t8 = new Date(T0.getTime() + 8 * 60_000); // 2 min left
    await runReminders({ db, notifier, now: t8, publicBaseUrl: BASE_URL });
    await runReminders({ db, notifier, now: new Date(t8.getTime() + 30_000), publicBaseUrl: BASE_URL });
    const out = texts(calls);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("A-0001 ($ 4.500 pesos argentinos) sigue pendiente y vence en 2 min");
    expect(out[0]).toContain(`${BASE_URL}/pay/${inv!.id}`);
    expect(out[0]).toContain("https://wa.me/?text=");

    await runReminders({ db, notifier, now: new Date(T0.getTime() + 11 * 60_000), publicBaseUrl: BASE_URL }); // expired: nothing
    expect(texts(calls)).toHaveLength(1);
  });
});

describe("runDailyClose", () => {
  it("fires at the merchant's local close hour, once per day, with totals and the CSV", async () => {
    const db = await createTestDb();
    const ar = await seedMerchant(db, { telegramUserId: 1n }); // Buenos Aires, close 21:00 = 00:00 UTC
    const br = await seedMerchant(db, { telegramUserId: 2n, country: "BR", dailyCloseHour: 20 }); // São Paulo 20:00 = 23:00 UTC
    await seedMerchant(db, { telegramUserId: 3n }); // no activity: never messaged
    const r = await createInvoice(db, ar, { amountLocal: "4500.5", description: "café", now: T0 });
    if (r.ok) await db.update(invoices).set({ status: "paid", paidAt: T0 }).where(eq(invoices.id, r.invoice.id));
    await createInvoice(db, ar, { amountLocal: "100", now: T0 });
    await createInvoice(db, br, { amountLocal: "30", now: T0 });
    const { notifier, calls } = notifierFor(db);

    await runDailyClose({ db, notifier, now: new Date("2026-11-02T22:30:00Z") }); // AR 19:30, BR 19:30
    expect(texts(calls)).toHaveLength(0);

    await runDailyClose({ db, notifier, now: new Date("2026-11-02T23:05:00Z") }); // BR 20:05
    expect(texts(calls)).toEqual([
      "Fechamento do dia 2026-11-02\nRecebido: R$ 0 reais (0 pagamentos)\nPendentes: 1 · Vencidas: 0 · Canceladas: 0\nCobranças criadas hoje: 1",
    ]);

    const t = new Date("2026-11-03T00:01:00Z"); // AR 21:01 on 2026-11-02
    await runDailyClose({ db, notifier, now: t });
    await runDailyClose({ db, notifier, now: new Date(t.getTime() + 60_000) }); // idempotent
    const out = texts(calls);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(
      "Cierre del día 2026-11-02\nCobrado: $ 4.500,50 pesos argentinos (1 pagos)\nPendientes: 1 · Vencidos: 0 · Cancelados: 0\nCobros creados hoy: 2",
    );
    const docs = sent(calls, "sendDocument");
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.payload.chat_id).sort()).toEqual([1, 2]);

    const markers = (await db.select().from(flags)).map((f) => f.key).filter((k) => k.startsWith("daily_close:"));
    // 3 markers: AR, BR, and the idle merchant (marked, not messaged)
    expect(markers).toHaveLength(3);
    expect(markers).toEqual(expect.arrayContaining([`daily_close:${ar.id}:2026-11-02`, `daily_close:${br.id}:2026-11-02`]));
    expect(markers.every((k) => k.endsWith(":2026-11-02"))).toBe(true);
  });
});

describe("Groq transcriber", () => {
  it("posts multipart audio to Groq Whisper with the bearer key", async () => {
    let seen: { url: string; auth: string | null; form: FormData } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get("authorization"), form: init.body as FormData };
      return new Response(JSON.stringify({ text: " cobrar 4500 café " }), { status: 200 });
    }) as unknown as typeof fetch;
    const tr = createGroqTranscriber({ apiKey: "gsk_test", fetch: fakeFetch, language: "es" });
    expect(await tr(new Uint8Array([1, 2]).buffer, "audio/ogg")).toBe("cobrar 4500 café");
    expect(seen!.url).toBe(GROQ_TRANSCRIPTION_URL);
    expect(seen!.auth).toBe("Bearer gsk_test");
    expect(seen!.form.get("model")).toBe("whisper-large-v3-turbo");
    expect(seen!.form.get("language")).toBe("es");
    expect((seen!.form.get("file") as File).name).toBe("voice.ogg");

    const failing = createGroqTranscriber({ apiKey: "k", fetch: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch });
    await expect(failing(new ArrayBuffer(1), "audio/ogg")).rejects.toThrow(/HTTP 401/);
    expect(groqTranscriberFromEnv({})).toBeUndefined();
    expect(typeof groqTranscriberFromEnv({ GROQ_API_KEY: "k" })).toBe("function");
  });
});

describe("createWebhookHandler", () => {
  it("rejects requests without the Telegram secret token", async () => {
    const db = await createTestDb();
    const handler = createWebhookHandler(
      { token: TOKEN, db, anthropicApiKey: "", publicBaseUrl: BASE_URL, secretToken: "s3cret" },
      { botInfo: BOT_INFO, model: null },
    );
    const res = await handler(new Request("https://x/api/telegram", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(401);
  });
});
