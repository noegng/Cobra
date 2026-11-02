import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../src/testing";
import { invoices, merchants, payments } from "../src/schema";
import type { Db } from "../src/client";
import {
  countInvoicesByStatus,
  dailyTotalsByMerchant,
  listInvoicesByMerchant,
  localDay,
  paymentCsvRows,
  toCsv,
} from "../src/queries";

const WARS = "0x0dc4F92879B7670e5f4e4e6e3c801D229129D90D";
const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const MERCHANT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const PAYER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

let db: Db;
let seq = 0;
let merchantId: string;
let otherMerchantId: string;

async function merchant(tz = "America/Argentina/Buenos_Aires"): Promise<string> {
  seq++;
  const [m] = await db
    .insert(merchants)
    .values({
      telegramUserId: BigInt(seq), telegramChatId: BigInt(seq), country: "AR", currency: "ARS",
      settlementToken: WARS, payoutAddress: MERCHANT, staticSlug: `m-${seq}`, timezone: tz,
    })
    .returning();
  return m!.id;
}

const hexId = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

async function invoice(
  mId: string,
  over: Partial<typeof invoices.$inferInsert> & { n: number },
): Promise<string> {
  const { n, ...rest } = over;
  const id = hexId(n);
  await db.insert(invoices).values({
    id, merchantId: mId, amountLocal: "100", currency: "ARS", tokenOut: WARS, amountOut: (100n * 10n ** 18n).toString(),
    merchantAddress: MERCHANT, expiresAt: new Date("2026-12-01T00:00:00Z"), createdAt: new Date(Date.UTC(2026, 10, 1, 0, n)),
    ...rest,
  });
  return id;
}

async function pay(invoiceId: string, paidAt: Date, amountOut: string, tokenOut = WARS, block = 1n): Promise<void> {
  await db.insert(payments).values({
    invoiceId, txHash: `0x${"ab".repeat(32)}`, logIndex: 0, payer: PAYER, tokenOut, amountOut, blockNumber: block, paidAt,
  });
}

beforeEach(async () => {
  db = await createTestDb();
  merchantId = await merchant();
  otherMerchantId = await merchant("America/Sao_Paulo");
});

describe("listInvoicesByMerchant", () => {
  it("filters by merchant and status, newest first, with limit and keyset pagination", async () => {
    await invoice(merchantId, { n: 1, status: "open" });
    await invoice(merchantId, { n: 2, status: "paid" });
    await invoice(merchantId, { n: 3, status: "open" });
    await invoice(merchantId, { n: 4, status: "expired" });
    await invoice(otherMerchantId, { n: 5, status: "open" });

    expect((await listInvoicesByMerchant(db, merchantId)).map((r) => r.id)).toEqual([hexId(4), hexId(3), hexId(2), hexId(1)]);
    expect((await listInvoicesByMerchant(db, merchantId, { status: "open" })).map((r) => r.id)).toEqual([hexId(3), hexId(1)]);
    expect((await listInvoicesByMerchant(db, merchantId, { status: ["paid", "expired"] })).map((r) => r.id)).toEqual([hexId(4), hexId(2)]);
    expect(await listInvoicesByMerchant(db, merchantId, { status: [] })).toEqual([]);
    const page1 = await listInvoicesByMerchant(db, merchantId, { limit: 2 });
    expect(page1.map((r) => r.id)).toEqual([hexId(4), hexId(3)]);
    const page2 = await listInvoicesByMerchant(db, merchantId, { limit: 2, before: page1.at(-1)!.createdAt });
    expect(page2.map((r) => r.id)).toEqual([hexId(2), hexId(1)]);
  });

  it("counts per status", async () => {
    await invoice(merchantId, { n: 1, status: "open" });
    await invoice(merchantId, { n: 2, status: "open" });
    await invoice(merchantId, { n: 3, status: "paid" });
    await invoice(otherMerchantId, { n: 4, status: "cancelled" });
    expect(await countInvoicesByStatus(db, merchantId)).toEqual({ open: 2, submitted: 0, paid: 1, expired: 0, cancelled: 0 });
  });
});

describe("dailyTotalsByMerchant", () => {
  it("groups by merchant-local day (not UTC), exact decimal / base-unit sums", async () => {
    // Buenos Aires is UTC-3: 02:30Z on Nov 3 is still Nov 2 locally.
    const a = await invoice(merchantId, { n: 1, amountLocal: "4500.50", status: "paid" });
    const b = await invoice(merchantId, { n: 2, amountLocal: "0.25", status: "paid" });
    const c = await invoice(merchantId, { n: 3, amountLocal: "1000", status: "paid" });
    const d = await invoice(merchantId, { n: 4, amountLocal: "10", currency: "USD", tokenOut: USDC, amountOut: "10000000", status: "paid" });
    const big = 123456789012345678901234567890n;
    await pay(a, new Date("2026-11-02T13:00:00Z"), big.toString());
    await pay(b, new Date("2026-11-03T02:30:00Z"), "1");
    await pay(c, new Date("2026-11-03T03:00:00Z"), "7");
    await pay(d, new Date("2026-11-02T20:00:00Z"), "10000000", USDC);
    const foreign = await invoice(otherMerchantId, { n: 9, status: "paid" });
    await pay(foreign, new Date("2026-11-02T13:00:00Z"), "999");

    const rows = await dailyTotalsByMerchant(db, merchantId, { from: "2026-11-01", to: "2026-11-30" });
    expect(rows).toEqual([
      { day: "2026-11-02", currency: "ARS", tokenOut: WARS, count: 2, amountLocal: "4500.75", amountOut: (big + 1n).toString() },
      { day: "2026-11-02", currency: "USD", tokenOut: USDC, count: 1, amountLocal: "10", amountOut: "10000000" },
      { day: "2026-11-03", currency: "ARS", tokenOut: WARS, count: 1, amountLocal: "1000", amountOut: "7" },
    ]);

    const utc = await dailyTotalsByMerchant(db, merchantId, { from: "2026-11-03", to: "2026-11-03", timezone: "UTC" });
    expect(utc).toEqual([{ day: "2026-11-03", currency: "ARS", tokenOut: WARS, count: 2, amountLocal: "1000.25", amountOut: "8" }]);

    expect(await dailyTotalsByMerchant(db, merchantId, { from: "2026-10-01", to: "2026-10-31" })).toEqual([]);
    await expect(dailyTotalsByMerchant(db, merchantId, { from: "2026-11-1", to: "2026-11-30" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("localDay formats a merchant-local date", () => {
    expect(localDay(new Date("2026-11-03T02:30:00Z"), "America/Argentina/Buenos_Aires")).toBe("2026-11-02");
    expect(localDay(new Date("2026-11-03T02:30:00Z"), "UTC")).toBe("2026-11-03");
  });
});

describe("paymentCsvRows / toCsv", () => {
  it("exports a merchant's payments in local time, oldest first, CSV-safe", async () => {
    const a = await invoice(merchantId, { n: 1, reference: "A-0001", description: 'Empanadas, "docena"', status: "paid" });
    const b = await invoice(merchantId, { n: 2, reference: "A-0002", description: "=HYPERLINK(\"http://evil\")", status: "paid" });
    await pay(b, new Date("2026-11-03T02:30:00Z"), "2", WARS, 20n);
    await pay(a, new Date("2026-11-02T13:00:05Z"), "1", WARS, 10n);
    const foreign = await invoice(otherMerchantId, { n: 9, status: "paid" });
    await pay(foreign, new Date("2026-11-02T13:00:00Z"), "999");

    const rows = await paymentCsvRows(db, merchantId);
    expect(rows.map((r) => r.invoiceId)).toEqual([a, b]);
    expect(rows[0]).toMatchObject({ paidAt: "2026-11-02T13:00:05.000Z", localDate: "2026-11-02", localTime: "10:00:05", amountOut: "1", blockNumber: "10" });
    expect(rows[1]).toMatchObject({ localDate: "2026-11-02", localTime: "23:30:00" });

    const windowed = await paymentCsvRows(db, merchantId, { from: new Date("2026-11-03T00:00:00Z"), to: new Date("2026-11-04T00:00:00Z") });
    expect(windowed.map((r) => r.invoiceId)).toEqual([b]);

    const csv = toCsv(rows);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("paidAt,localDate,localTime,invoiceId,reference,description,amountLocal,currency,tokenOut,amountOut,payer,txHash,blockNumber");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"Empanadas, ""docena"""');
    expect(lines[2]).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(toCsv([])).toBe(`${lines[0]}\r\n`);
  });
});
