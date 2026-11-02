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

import { getAddress } from "viem";
import { transitionInvoice, onchainInvoiceFromRow, isKillSwitchOn, setFlag } from "../src/repo";

describe("repo helpers", () => {
  it("transitions atomically and rebuilds the on-chain invoice", async () => {
    const db = await createTestDb();
    const [m] = await db.insert(merchants).values({
      telegramUserId: 2n, telegramChatId: 2n, country: "BR", currency: "BRL",
      settlementToken: "0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0",
      payoutAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", staticSlug: "salao-bia",
    }).returning();
    const id = `0x${"22".repeat(32)}`;
    const expiresAt = new Date(1_800_000_000_000);
    await db.insert(invoices).values({
      id, merchantId: m!.id, amountLocal: "30", currency: "BRL", tokenOut: m!.settlementToken,
      amountOut: (30n * 10n ** 18n).toString(), merchantAddress: m!.payoutAddress, expiresAt,
    });
    expect(await transitionInvoice(db, id, ["open"], "submitted")).not.toBeNull();
    expect(await transitionInvoice(db, id, ["open"], "submitted")).toBeNull(); // already moved
    await expect(transitionInvoice(db, id, ["paid"], "open")).rejects.toThrow(/illegal/);
    const row = await transitionInvoice(db, id, ["submitted"], "paid", { paidAt: new Date() });
    expect(row?.status).toBe("paid");
    const onchain = onchainInvoiceFromRow(row!);
    expect(onchain.deadline).toBe(1_800_000_000n);
    expect(onchain.amountOut).toBe(30n * 10n ** 18n);
    expect(onchain.tokenOut).toBe(getAddress("0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0"));
  });

  it("kill switch reads env and flag", async () => {
    const db = await createTestDb();
    expect(await isKillSwitchOn(db, {})).toBe(false);
    expect(await isKillSwitchOn(db, { KILL_SWITCH: "true" })).toBe(true);
    await setFlag(db, "kill_switch", { enabled: true });
    expect(await isKillSwitchOn(db, {})).toBe(true);
  });
});
