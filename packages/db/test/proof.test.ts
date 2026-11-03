import { describe, expect, it } from "vitest";
import { createTestDb } from "../src/testing";
import { invoices, merchants, payments } from "../src/schema";
import { proofStats } from "../src/queries";

const WARS = "0x0dc4F92879B7670e5f4e4e6e3c801D229129D90D";
const WBRL = "0xE2702Bd97ee33c88c8f6f92DB3a5f3Ff3ca7f2b9";
const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const P1 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const P2 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

describe("proofStats", () => {
  it("empty database", async () => {
    const s = await proofStats(await createTestDb());
    expect(s).toEqual({ paymentCount: 0, distinctPayers: 0, merchantCount: 0, avgSavingsBps: null, volumeByToken: [], recent: [] });
  });

  it("aggregates payments, each linked to a tx", async () => {
    const db = await createTestDb();
    const mids: string[] = [];
    for (let i = 1; i <= 2; i++) {
      const [m] = await db.insert(merchants).values({
        telegramUserId: BigInt(i), telegramChatId: BigInt(i), country: "AR", currency: "ARS",
        settlementToken: WARS, payoutAddress: ADDR, staticSlug: `m-${i}`,
      }).returning();
      mids.push(m!.id);
    }
    const rows = [
      { n: 1, m: 0, payer: P1, token: WARS, amt: 100n, sav: 40 },
      { n: 2, m: 0, payer: P1.toLowerCase(), token: WARS, amt: 250n, sav: 60 },
      { n: 3, m: 1, payer: P2, token: WBRL, amt: 7n, sav: null },
    ];
    for (const r of rows) {
      await db.insert(invoices).values({
        id: hex(r.n), merchantId: mids[r.m]!, amountLocal: "1", currency: "ARS", tokenOut: r.token, amountOut: r.amt.toString(),
        merchantAddress: ADDR, expiresAt: new Date("2026-12-01T00:00:00Z"), status: "paid",
      });
      await db.insert(payments).values({
        invoiceId: hex(r.n), txHash: hex(1000 + r.n), logIndex: 0, payer: r.payer, tokenOut: r.token, amountOut: r.amt.toString(),
        savingsBps: r.sav, blockNumber: BigInt(r.n), paidAt: new Date(Date.UTC(2026, 10, r.n)),
      });
    }
    const s = await proofStats(db);
    expect(s.paymentCount).toBe(3);
    expect(s.distinctPayers).toBe(2);
    expect(s.merchantCount).toBe(2);
    expect(s.avgSavingsBps).toBe(50);
    expect(s.volumeByToken.find((v) => v.tokenOut === WARS)).toMatchObject({ count: 2, amountOut: "350" });
    expect(s.recent.map((p) => p.txHash)).toEqual([hex(1003), hex(1002), hex(1001)]);
    expect(s.recent.length).toBe(s.paymentCount);
  });
});
