import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../src/testing";
import { invoices, merchants, submissions } from "../src/schema";

describe("schema (PGlite)", () => {
  it("applies migrations and enforces one live submission per invoice", async () => {
    const db = await createTestDb();
    const [m] = await db
      .insert(merchants)
      .values({
        telegramUserId: 1n, telegramChatId: 1n, country: "AR", currency: "ARS",
        settlementToken: "0x0dc4F92879B7670e5f4e4e6e3c801D229129D90D",
        payoutAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", staticSlug: "kiosco-ana",
      })
      .returning();
    const id = `0x${"11".repeat(32)}`;
    await db.insert(invoices).values({
      id, merchantId: m!.id, amountLocal: "4500", currency: "ARS",
      tokenOut: m!.settlementToken, amountOut: (4500n * 10n ** 18n).toString(),
      merchantAddress: m!.payoutAddress, expiresAt: new Date(Date.now() + 600_000),
    });
    await db.insert(submissions).values({ invoiceId: id, payer: "0xabc", legs: [] });
    await expect(db.insert(submissions).values({ invoiceId: id, payer: "0xabc", legs: [] })).rejects.toThrow();
    await db.update(submissions).set({ status: "failed" }).where(eq(submissions.invoiceId, id));
    await db.insert(submissions).values({ invoiceId: id, payer: "0xabc", legs: [] }); // retry allowed after failure
    const rows = await db.select().from(submissions).where(eq(submissions.invoiceId, id));
    expect(rows).toHaveLength(2);
  });
});
