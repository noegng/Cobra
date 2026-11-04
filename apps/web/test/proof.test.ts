import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTestDb } from "@cobra/db/testing";
import { invoices, merchants, payments } from "@cobra/db";
import { proofStats } from "@cobra/db/queries";
import { ProofView } from "../components/proof-view";
import { MERCHANT_PAYOUT, WARS, payer } from "./helpers";

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const render = (stats: Awaited<ReturnType<typeof proofStats>>, lang: "es" | "pt" | "en" = "es", agent: string | null = AGENT) =>
  renderToStaticMarkup(createElement(ProofView, { stats, lang, agentAddress: agent, routerAddress: null, agentId: 10033 }));

describe("/proof view: routers", () => {
  it("shows both routers when a legacy one is configured", async () => {
    const stats = await proofStats(await createTestDb());
    const V2 = "0x00000000000000000000000000000000c0b4a002";
    const V1 = "0x00000000000000000000000000000000c0b4a000";
    const html = renderToStaticMarkup(createElement(ProofView, { stats, lang: "en", agentAddress: AGENT, routerAddress: V2, legacyRouterAddress: V1, agentId: 10033 }));
    expect(html).toContain(`/address/${V2}`);
    expect(html).toContain(`/address/${V1}`);
    expect(render(stats)).not.toContain("v1");
  });
});

describe("/proof view", () => {
  it("empty state", async () => {
    const html = render(await proofStats(await createTestDb()), "en", null);
    expect(html).toContain("No confirmed payments yet.");
    expect(html).not.toContain("/tx/");
    expect(html).toContain("not configured");
  });

  it("every payment links to its Celoscan tx, in each language", async () => {
    const db = await createTestDb();
    const [m] = await db.insert(merchants).values({
      telegramUserId: 1n, telegramChatId: 1n, country: "AR", currency: "ARS", settlementToken: WARS.address, payoutAddress: MERCHANT_PAYOUT, staticSlug: "m",
    }).returning();
    for (let n = 1; n <= 3; n++) {
      await db.insert(invoices).values({
        id: hex(n), merchantId: m!.id, amountLocal: "1", currency: "ARS", tokenOut: WARS.address, amountOut: (BigInt(n) * 10n ** 18n).toString(),
        merchantAddress: MERCHANT_PAYOUT, expiresAt: new Date("2026-12-01T00:00:00Z"), status: "paid",
      });
      await db.insert(payments).values({
        invoiceId: hex(n), txHash: hex(500 + n), logIndex: 0, payer: payer.address, tokenOut: WARS.address, amountOut: (BigInt(n) * 10n ** 18n).toString(),
        savingsBps: 50, blockNumber: BigInt(n), paidAt: new Date(Date.UTC(2026, 10, n)),
      });
    }
    const stats = await proofStats(db);
    for (const lang of ["es", "pt", "en"] as const) {
      const html = render(stats, lang);
      for (let n = 1; n <= 3; n++) expect(html).toContain(`/tx/${hex(500 + n)}`);
      expect((html.match(/\/tx\//g) ?? []).length).toBe(stats.paymentCount);
      expect(html).toContain(`/address/${AGENT}`);
      expect(html).toContain("https://8004scan.io/agents/celo/10033");
    }
  });
});
