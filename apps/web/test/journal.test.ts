import { describe, expect, it, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { getAddress } from "viem";
import { PullKind, encodePath } from "@cobra/shared";
import { createTestDb } from "@cobra/db/testing";
import { flags, invoices, merchants, payments, quotes, submissions, type Db } from "@cobra/db";
import { JournalView } from "../components/journal-view";
import { AGENT_WALLET, ERC8021_TAG, bpsPercent, describeRoute, feeTierLabel, queryJournal } from "../lib/server/journal";
import { handleJournalGet, resetJournalCache } from "../lib/server/journal-api";
import { createMemoryRateLimiter } from "../lib/server/rate-limit";
import { USDT, WARS } from "./helpers";

// Real Celo mainnet transactions (read via public RPC on 2026-11-03).
const TX_ROUTE = "0x7951aea4693affabca3250605dcb43ee8ecebe2597a9dd416a06aa58fe07ddc3";
const TX_GRANT = "0x0052cc07e384c7cd8794b9f0514c298ea3a60719d862097d6d971bb02f2af0fe";
const TX_PERMIT2 = "0x66cc8e5185076c10fd03cc0ce3e591e5e84395885ce6b67a7f42304352a2fb19";
const PAYER1 = getAddress("0x2891289891d6237614771363accb6327b56e18dc");
const PAYER3 = getAddress("0xba42b1c3f23c06b2ca65cc31a98dc9a80dcf85b7");
const MERCHANT = getAddress("0x22e6730f4943a30bab8a755cb11ed5d3ebe732a0");
const SECRET_DESC = "SECRET-DESCRIPTION-lunch";
const SECRET_NAME = "SECRET-Café-Luna";
// block timestamp of the first tx (0x6aea5036); the grant and the Permit2 payment landed 743 / 922 blocks (~s) later.
const T_ROUTE = 0x6aea5036 * 1000;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

async function seed(): Promise<Db> {
  const db = await createTestDb();
  const [m] = await db.insert(merchants).values({
    telegramUserId: 987654321n, telegramChatId: 987654321n, displayName: SECRET_NAME, country: "AR", currency: "ARS",
    settlementToken: WARS.address, payoutAddress: MERCHANT, staticSlug: "secret-slug",
  }).returning();
  const mk = (n: number, amountLocal: string, amountOut: string, token = WARS.address, extra: object = {}) =>
    db.insert(invoices).values({
      id: id(n), merchantId: m!.id, amountLocal, currency: "ARS", tokenOut: token, amountOut, merchantAddress: MERCHANT,
      description: SECRET_DESC, reference: "SECRET-REF", expiresAt: new Date("2026-12-01T00:00:00Z"), status: "paid", ...extra,
    });

  // 1) 100 ARS invoice, 0.060673 USDT -> exactly 100 wARS, 0.47 wARS refunded (swap output 100.47).
  await mk(1, "100", (100n * 10n ** 18n).toString());
  const leg1 = { token: USDT.address, amountIn: "60673", kind: PullKind.EIP3009, path: encodePath([USDT.address, WARS.address], [100]) };
  const [q1] = await db.insert(quotes).values({
    invoiceId: id(1), payer: PAYER1, expiresAt: new Date("2026-11-02T12:00:00Z"),
    plan: { legs: [{ ...leg1, quotedOut: "100470000000000000000" }], tokenOut: WARS.address, minOut: "100000000000000000000", costBps: 9, naiveCostBps: 30, savingsBps: 21, quotedAt: 1, expiresAt: 2 },
  }).returning();
  await db.insert(submissions).values({ invoiceId: id(1), quoteId: q1!.id, payer: PAYER1, legs: [{ ...leg1, pullData: "0x" }], status: "confirmed", txHash: TX_ROUTE });
  await db.insert(payments).values({
    invoiceId: id(1), txHash: TX_ROUTE, logIndex: 5, payer: PAYER1, tokenOut: WARS.address, amountOut: (100n * 10n ** 18n).toString(),
    legs: [{ ...leg1, pullData: "0x" }], costBps: 9, savingsBps: 21, blockNumber: 81840096n, paidAt: new Date(T_ROUTE),
  });

  // 3) 1000 wARS paid directly via Permit2 (single leg, no swap).
  await mk(3, "1000", (1000n * 10n ** 18n).toString());
  const leg3 = { token: WARS.address, amountIn: (1000n * 10n ** 18n).toString(), kind: PullKind.PERMIT2, path: WARS.address, pullData: "0x" };
  await db.insert(submissions).values({ invoiceId: id(3), payer: PAYER3, legs: [leg3], status: "confirmed", txHash: TX_PERMIT2 });
  await db.insert(payments).values({
    invoiceId: id(3), txHash: TX_PERMIT2, logIndex: 2, payer: PAYER3, tokenOut: WARS.address, amountOut: (1000n * 10n ** 18n).toString(),
    legs: [leg3], blockNumber: 81841018n, paidAt: new Date(T_ROUTE + 922_000),
  });

  // 2) gas grant of 0.05 CELO + a pending/signing one that must not show.
  await db.insert(flags).values({
    key: `gas_grant:${PAYER3.toLowerCase()}`, value: { status: "sent", value: "50000000000000000", txHash: TX_GRANT, invoiceId: id(3) },
    updatedAt: new Date(T_ROUTE + 743_000),
  });
  await db.insert(flags).values({ key: `gas_grant:${"0x" + "1".repeat(40)}`, value: { status: "signing", value: "50000000000000000" } });

  // counters: reminder, failed submission, daily close
  await mk(4, "5", "5", WARS.address, { status: "expired", lastReminderAt: new Date("2026-11-02T10:00:00Z") });
  await db.insert(submissions).values({ invoiceId: id(4), payer: PAYER1, legs: [], status: "failed", error: "SECRET-ERROR price_guard", updatedAt: new Date("2026-11-02T11:00:00Z") });
  await db.insert(flags).values({ key: `daily_close:${m!.id}:2026-11-02`, value: { at: "x" } });
  return db;
}

const NOW = new Date("2026-11-04T08:00:00Z");

describe("pure formatting", () => {
  it("fee tiers and bps without floats", () => {
    expect([100, 500, 3000, 10000].map(feeTierLabel)).toEqual(["0.01", "0.05", "0.3", "1"]);
    expect(bpsPercent(9)).toBe("0.09");
    expect(bpsPercent(250)).toBe("2.50");
    expect(bpsPercent(21, "es")).toBe("0,21");
  });
});

describe("agent journal", () => {
  let db: Db;
  beforeEach(async () => {
    db = await seed();
    resetJournalCache();
  });

  it("reproduces the three real transactions, newest first", async () => {
    const j = await queryJournal(db, { now: NOW });
    expect(j.entries.map((e) => e.txHash)).toEqual([TX_PERMIT2, TX_GRANT, TX_ROUTE]);

    const [permit2, grant, route] = j.entries;
    expect(route).toMatchObject({
      type: "route", amountOut: "100000000000000000000", symbolOut: "wARS", legCount: 1, split: false,
      quotedSurplus: "470000000000000000", costBps: 9, savingsBps: 21, relayed: true, sender: AGENT_WALLET, attributionTag: ERC8021_TAG,
      amountLocal: "100", currency: "ARS",
    });
    if (route?.type !== "route") throw new Error();
    expect(route.legs[0]).toMatchObject({ symbolIn: "USDT", amountIn: "60673", kind: "eip3009", hops: ["USDT", "wARS"], fees: [100] });
    expect(describeRoute(route.legs)).toBe("USDT → wARS · Uniswap V3 0.01 %");

    expect(grant).toMatchObject({ type: "gas_grant", to: PAYER3, value: "50000000000000000", sender: AGENT_WALLET, purpose: "permit2_approval" });
    expect(permit2).toMatchObject({ type: "route", amountOut: "1000000000000000000000", quotedSurplus: null, costBps: null });
    if (permit2?.type !== "route") throw new Error();
    expect(permit2.legs[0]).toMatchObject({ kind: "permit2", symbolIn: "wARS" });
  });

  it("counts per day only", async () => {
    const j = await queryJournal(db, { now: NOW });
    expect(j.days).toEqual([{ date: "2026-11-02", remindersSent: 1, dailyCloses: 1, failedSubmissions: 1 }]);
  });

  it("renders amounts, links and counts in each language", async () => {
    const j = await queryJournal(db, { now: NOW });
    for (const lang of ["es", "pt", "en"] as const) {
      const html = renderToStaticMarkup(createElement(JournalView, { journal: j, lang }));
      for (const tx of [TX_ROUTE, TX_GRANT, TX_PERMIT2]) expect(html).toContain(`/tx/${tx}`);
      expect(html).toContain(lang === "en" ? "0.060673" : "0,060673");
      expect(html).toContain("USDT → wARS · Uniswap V3 0.01 %");
      expect(html).toContain("0xba42…85b7");
      expect(html).toContain(ERC8021_TAG);
      expect(html).toContain("/api/agent/journal");
    }
    const en = renderToStaticMarkup(createElement(JournalView, { journal: j, lang: "en" }));
    expect(en).toContain("Sent 0.05 CELO to");
    expect(en).toContain("0.47 wARS");
    expect(en).toContain("100 wARS");
  });

  it("never leaks private data (HTML and JSON)", async () => {
    const j = await queryJournal(db, { now: NOW });
    const blob = renderToStaticMarkup(createElement(JournalView, { journal: j, lang: "es" })) + JSON.stringify(j);
    for (const s of [SECRET_DESC, SECRET_NAME, "SECRET-REF", "SECRET-ERROR", "secret-slug", "987654321", MERCHANT, MERCHANT.toLowerCase()]) {
      expect(blob).not.toContain(s);
    }
  });

  it("empty state", async () => {
    const empty = await queryJournal(await createTestDb(), { now: NOW });
    expect(empty.entries).toEqual([]);
    expect(renderToStaticMarkup(createElement(JournalView, { journal: empty, lang: "en" }))).toContain("No decisions recorded yet.");
  });
});

describe("GET /api/agent/journal", () => {
  it("serves JSON, caches, and rate-limits", async () => {
    resetJournalCache();
    const db = await seed();
    let t = Date.UTC(2026, 10, 4, 8);
    const rateLimiter = createMemoryRateLimiter({ journal: { limit: 2, windowMs: 60_000 } });
    const get = () => handleJournalGet(new Request("http://x/api/agent/journal", { headers: { "x-forwarded-for": "198.51.100.1" } }), { db, now: () => t, rateLimiter });
    const r1 = await get();
    expect(r1.status).toBe(200);
    expect(r1.headers.get("cache-control")).toContain("s-maxage=10");
    const body = await r1.json();
    expect(body.entries).toHaveLength(3);
    await db.delete(flags); // cache: still served within 10 s
    t += 1000;
    expect((await (await get()).json()).entries).toHaveLength(3);
    t += 1000;
    const r3 = await get();
    expect(r3.status).toBe(429);
    expect(r3.headers.get("retry-after")).toBeTruthy();
  });
});
