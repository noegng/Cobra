import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { decodeAbiParameters, getAddress, recoverTypedDataAddress, serializeSignature, type Hex } from "viem";
import {
  PullKind,
  deserializeLeg,
  eip3009TypedData,
  intentDigest,
  legNonce,
  permit2TypedData,
  toBaseUnits,
  type SerializedLeg,
} from "@cobra/shared";
import { invoices, onchainInvoiceFromRow, quotes, setFlag, submissions } from "@cobra/db";
import { handleCreateStaticInvoice, handleGetInvoice, handleQuote, handleStatus, handleSubmit } from "../lib/server/api";
import type { QuoteError, QuoteOk, StatusResponse } from "../lib/wire";
import { privateKeyToAccount } from "viem/accounts";
import { buildLegSigning } from "../lib/server/signing";
import { deserializePlan, type SerializedPlan } from "@cobra/shared";
import { MERCHANT_PAYOUT, ROUTER, T0, USDC, WARS, other, payer, planFor, req, setup, signAll } from "./helpers";

async function quote(fx: Awaited<ReturnType<typeof setup>>, who = payer.address) {
  const res = await handleQuote(req("POST", { payer: who }), fx.invoiceId, fx.deps);
  return { res, body: (await res.json()) as QuoteOk & QuoteError };
}

describe("GET /api/invoices/:id", () => {
  it("returns the public view", async () => {
    const fx = await setup();
    const res = await handleGetInvoice(req("GET"), fx.invoiceId, fx.deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: fx.invoiceId,
      merchantName: "Café Luna",
      amountLocal: "2400",
      currency: "ARS",
      tokenOut: WARS.address,
      tokenOutSymbol: "wARS",
      amountOut: (2400n * 10n ** 18n).toString(),
      payoutAddress: MERCHANT_PAYOUT,
      status: "open",
    });
    expect(JSON.stringify(body)).not.toMatch(/telegram/i);
  });

  it("404 on unknown / malformed id and reports expired effective status", async () => {
    const fx = await setup();
    expect((await handleGetInvoice(req("GET"), "0x1234", fx.deps)).status).toBe(404);
    expect((await handleGetInvoice(req("GET"), `0x${"ab".repeat(32)}`, fx.deps)).status).toBe(404);
    fx.clock.now = T0 + 11 * 60_000;
    expect((await (await handleGetInvoice(req("GET"), fx.invoiceId, fx.deps)).json()).status).toBe("expired");
  });
});

describe("quote → sign → submit", () => {
  it("end-to-end EIP-3009 leg: pending submission with correct, decodable pullData", async () => {
    const fx = await setup();
    const { res, body } = await quote(fx);
    expect(res.status).toBe(200);
    expect(body.toSign).toHaveLength(1);
    expect(body.toSign[0]!.kind).toBe("EIP3009");
    expect(body.router).toBe(ROUTER);
    expect(body.needsPermit2Approval).toEqual([]);
    // the solver received the frozen on-chain invoice terms
    expect(fx.solverCalls[0]!.invoice.amountOut).toBe(2400n * 10n ** 18n);
    expect(fx.solverCalls[0]!.invoice.deadline).toBe(BigInt((T0 + 10 * 60_000) / 1000));

    // typed data matches the frozen scheme exactly
    const [row] = await fx.db.select().from(invoices).where(eq(invoices.id, fx.invoiceId));
    const inv = onchainInvoiceFromRow(row!);
    const plan = planFor(fx.solverCalls[0]!, T0);
    const digest = intentDigest(ROUTER, 42220, inv, payer.address, plan.legs);
    const expected = eip3009TypedData({
      token: USDC.address,
      tokenDomain: { name: "USDC", version: "2" },
      chainId: 42220,
      from: payer.address,
      router: ROUTER,
      value: 1_470_000n,
      validAfter: 0n,
      validBefore: inv.deadline,
      nonce: legNonce(digest, 0),
    });
    const td = body.toSign[0]!.typedData!;
    expect(td.domain).toEqual(expected.domain);
    expect(td.message).toEqual({ ...expected.message, value: "1470000", validAfter: "0", validBefore: inv.deadline.toString() });

    const signatures = await signAll(body.toSign);
    const sub = await handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), fx.invoiceId, fx.deps);
    expect(sub.status).toBe(202);
    const { submissionId } = await sub.json();

    const [s] = await fx.db.select().from(submissions).where(eq(submissions.id, submissionId));
    expect(s!.status).toBe("pending");
    expect(s!.payer).toBe(payer.address);
    expect(s!.quoteId).toBe(body.quoteId);
    const legs = (s!.legs as SerializedLeg[]).map(deserializeLeg);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.token).toBe(USDC.address);
    expect(legs[0]!.amountIn).toBe(1_470_000n);
    expect(legs[0]!.kind).toBe(PullKind.EIP3009);
    expect(legs[0]!.path).toBe(plan.legs[0]!.path);
    const [validAfter, validBefore, v, r, sSig] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
      legs[0]!.pullData,
    );
    expect(validAfter).toBe(0n);
    expect(validBefore).toBe(inv.deadline);
    expect([27, 28]).toContain(v);
    const recovered = await recoverTypedDataAddress({ ...expected, signature: serializeSignature({ r, s: sSig, v: BigInt(v) }) });
    expect(recovered).toBe(payer.address);

    // status reflects the queue, then the relayer's tx hash
    let st = (await (await handleStatus(req("GET"), fx.invoiceId, fx.deps)).json()) as StatusResponse;
    expect(st).toMatchObject({ status: "open", submission: { status: "pending", txHash: null }, explorerUrl: null });
    const tx = `0x${"11".repeat(32)}` as Hex;
    await fx.db.update(submissions).set({ status: "sent", txHash: tx }).where(eq(submissions.id, submissionId));
    st = (await (await handleStatus(req("GET"), fx.invoiceId, fx.deps)).json()) as StatusResponse;
    expect(st.txHash).toBe(tx);
    expect(st.explorerUrl).toBe(`https://celoscan.io/tx/${tx}`);
  });

  it("Permit2 leg: nonce = uint256(legNonce), witness, pullData (nonce, deadline, sig)", async () => {
    const fx = await setup();
    fx.setSolver((input) => ({
      ok: true,
      plan: planFor(input, fx.clock.now, [
        { token: WARS.address, amountIn: 1000n * 10n ** 18n, kind: PullKind.PERMIT2, path: "0x", quotedOut: 1000n * 10n ** 18n },
        { token: USDC.address, amountIn: 860_000n, kind: PullKind.EIP3009, path: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C00006448065fbBE25f71C9282ddf5e1cD6D6A887483D5e0000640dc4f92879b7670e5f4e4e6e3c801d229129d90d", quotedOut: 1400n * 10n ** 18n },
      ]),
    }));
    const { res, body } = await quote(fx);
    expect(res.status).toBe(200);
    expect(body.toSign.map((e) => e.kind)).toEqual(["PERMIT2", "EIP3009"]);
    const [row] = await fx.db.select().from(invoices).where(eq(invoices.id, fx.invoiceId));
    const inv = onchainInvoiceFromRow(row!);
    const plan = (await fx.db.select().from(quotes).where(eq(quotes.id, body.quoteId)))[0]!.plan as { legs: { token: string }[] };
    expect(plan.legs).toHaveLength(2);
    const legsForDigest = planFor(fx.solverCalls[0]!, T0, [
      { token: WARS.address, amountIn: 1000n * 10n ** 18n, kind: PullKind.PERMIT2, path: "0x", quotedOut: 0n },
      { token: USDC.address, amountIn: 860_000n, kind: PullKind.EIP3009, path: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C00006448065fbBE25f71C9282ddf5e1cD6D6A887483D5e0000640dc4f92879b7670e5f4e4e6e3c801d229129d90d", quotedOut: 0n },
    ]).legs;
    const digest = intentDigest(ROUTER, 42220, inv, payer.address, legsForDigest);
    const nonce = BigInt(legNonce(digest, 0));
    expect(body.toSign[0]!.typedData!.message.nonce).toBe(nonce.toString());
    expect(body.toSign[1]!.typedData!.message.nonce).toBe(legNonce(digest, 1));

    const signatures = await signAll(body.toSign);
    const sub = await handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), fx.invoiceId, fx.deps);
    expect(sub.status).toBe(202);
    const [s] = await fx.db.select().from(submissions);
    const legs = (s!.legs as SerializedLeg[]).map(deserializeLeg);
    const [pn, pd, psig] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }], legs[0]!.pullData);
    expect(pn).toBe(nonce);
    expect(pd).toBe(inv.deadline);
    const expected = permit2TypedData({
      permit2: fx.deps.permit2,
      chainId: 42220,
      token: WARS.address,
      amount: 1000n * 10n ** 18n,
      router: ROUTER,
      nonce,
      deadline: inv.deadline,
      invoice: inv,
      payer: payer.address,
      legs: legsForDigest,
    });
    expect(await recoverTypedDataAddress({ ...expected, signature: psig })).toBe(payer.address);
  });

  it("flags tokens that still need a Permit2 approval", async () => {
    const fx = await setup();
    fx.setSolver((input) => ({
      ok: true,
      plan: planFor(input, fx.clock.now, [
        { token: USDC.address, amountIn: 1_470_000n, kind: PullKind.PERMIT2, path: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C00006448065fbBE25f71C9282ddf5e1cD6D6A887483D5e0000640dc4f92879b7670e5f4e4e6e3c801d229129d90d", quotedOut: 0n },
      ]),
    }));
    const { body } = await quote(fx);
    expect(body.needsPermit2Approval).toEqual([USDC.address]);
  });
});

describe("submit rejections", () => {
  it("expired quote → 410", async () => {
    const fx = await setup();
    const { body } = await quote(fx);
    const signatures = await signAll(body.toSign);
    fx.clock.now += 61_000;
    const res = await handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), fx.invoiceId, fx.deps);
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe("quote_expired");
    expect(await fx.db.select().from(submissions)).toHaveLength(0);
  });

  it("wrong signer → 400", async () => {
    const fx = await setup();
    const { body } = await quote(fx);
    const signatures = await signAll(body.toSign, other);
    const res = await handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), fx.invoiceId, fx.deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_signature", leg: 0 });
  });

  it("tampered amount (payer signed a different value) → 400", async () => {
    const fx = await setup();
    const { body } = await quote(fx);
    const tampered = structuredClone(body.toSign);
    tampered[0]!.typedData!.message.value = "1";
    const signatures = await signAll(tampered);
    const res = await handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), fx.invoiceId, fx.deps);
    expect(res.status).toBe(400);
    expect(await fx.db.select().from(submissions)).toHaveLength(0);
  });

  it("quote of another invoice, malformed signature, wrong count", async () => {
    const fx = await setup();
    const { body } = await quote(fx);
    const signatures = await signAll(body.toSign);
    expect((await handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), `0x${"cd".repeat(32)}`, fx.deps)).status).toBe(404);
    expect((await handleSubmit(req("POST", { quoteId: body.quoteId, signatures: ["0x1234"] }), fx.invoiceId, fx.deps)).status).toBe(400);
    expect((await handleSubmit(req("POST", { quoteId: body.quoteId, signatures: [...signatures, ...signatures] }), fx.invoiceId, fx.deps)).status).toBe(400);
    expect((await handleSubmit(req("POST", { quoteId: "nope", signatures }), fx.invoiceId, fx.deps)).status).toBe(400);
  });

  it("double submit → 409 (sequential and concurrent)", async () => {
    const fx = await setup();
    const { body } = await quote(fx);
    const signatures = await signAll(body.toSign);
    const first = await handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), fx.invoiceId, fx.deps);
    expect(first.status).toBe(202);
    const again = await handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), fx.invoiceId, fx.deps);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("already_submitted");

    const fx2 = await setup();
    const q2 = await quote(fx2);
    const sigs2 = await signAll(q2.body.toSign);
    const results = await Promise.all(
      [0, 1, 2].map(() => handleSubmit(req("POST", { quoteId: q2.body.quoteId, signatures: sigs2 }), fx2.invoiceId, fx2.deps)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([202, 409, 409]);
    expect(await fx2.db.select().from(submissions)).toHaveLength(1);
  });

  it("a failed submission frees the invoice for a new one", async () => {
    const fx = await setup();
    const { body } = await quote(fx);
    const signatures = await signAll(body.toSign);
    expect((await handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), fx.invoiceId, fx.deps)).status).toBe(202);
    await fx.db.update(submissions).set({ status: "failed" });
    const q2 = await quote(fx);
    const res = await handleSubmit(req("POST", { quoteId: q2.body.quoteId, signatures: await signAll(q2.body.toSign) }), fx.invoiceId, fx.deps);
    expect(res.status).toBe(202);
  });

  it("invoice no longer open → 409", async () => {
    const fx = await setup();
    const { body } = await quote(fx);
    await fx.db.update(invoices).set({ status: "submitted" }).where(eq(invoices.id, fx.invoiceId));
    const res = await handleSubmit(req("POST", { quoteId: body.quoteId, signatures: await signAll(body.toSign) }), fx.invoiceId, fx.deps);
    expect(res.status).toBe(409);
  });
});

describe("WS7-1: self-payment (payer == invoice merchant)", () => {
  // anvil's public test account #2 — the fixture merchant payout address.
  const merchantAcc = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

  it("quote is refused with 400 self_payment, nothing stored", async () => {
    const fx = await setup();
    expect(merchantAcc.address).toBe(MERCHANT_PAYOUT);
    const { res, body } = await quote(fx, MERCHANT_PAYOUT);
    expect(res.status).toBe(400);
    expect(body.error).toBe("self_payment");
    expect(await fx.db.select().from(quotes)).toHaveLength(0);
  });

  it("submit of a correctly signed self-payment quote is refused, no submission", async () => {
    const fx = await setup();
    const { body } = await quote(fx);
    // A quote whose payer is the merchant itself (e.g. stored before the quote-side check), signed by the merchant.
    await fx.db.update(quotes).set({ payer: MERCHANT_PAYOUT }).where(eq(quotes.id, body.quoteId));
    const [q] = await fx.db.select().from(quotes).where(eq(quotes.id, body.quoteId));
    const [row] = await fx.db.select().from(invoices).where(eq(invoices.id, fx.invoiceId));
    const signing = buildLegSigning({
      router: ROUTER, chainId: 42220, permit2: fx.deps.permit2, invoice: onchainInvoiceFromRow(row!),
      payer: MERCHANT_PAYOUT, legs: deserializePlan(q!.plan as SerializedPlan).legs,
    });
    const signatures = await Promise.all(signing.map((x) => merchantAcc.signTypedData(x.typedData as never)));
    const res = await handleSubmit(req("POST", { quoteId: body.quoteId, signatures }), fx.invoiceId, fx.deps);
    expect(await res.json()).toEqual({ error: "self_payment" });
    expect(res.status).toBe(400);
    expect(await fx.db.select().from(submissions)).toHaveLength(0);
  });
});

describe("quote rejections", () => {
  it("expired invoice → 410, invalid payer → 400, kill switch → 503", async () => {
    const fx = await setup();
    expect((await handleQuote(req("POST", { payer: "0xnope" }), fx.invoiceId, fx.deps)).status).toBe(400);
    await setFlag(fx.db, "kill_switch", { enabled: true });
    expect((await quote(fx)).res.status).toBe(503);
    await setFlag(fx.db, "kill_switch", { enabled: false });
    fx.clock.now = T0 + 10 * 60_000 - 5_000; // less than MIN_REMAINING_MS left
    expect((await quote(fx)).res.status).toBe(410);
  });

  it("insufficient balance → 422 with honest direct-transfer fallback, public Ripio on-ramp link", async () => {
    const fx = await setup();
    fx.setSolver(() => ({ ok: false, reason: "insufficient_balance", fallback: "ripio" }));
    const { res, body } = await quote(fx);
    expect(res.status).toBe(422);
    expect(body.error).toBe("insufficient_balance");
    // Prefilled: country, Celo, token, invoice amount (rounded up to cents) and the payer's own wallet.
    const ramp = new URL(body.rampUrl!);
    expect(`${ramp.origin}${ramp.pathname}`).toBe("https://ramp.ripio.com/");
    expect(ramp.searchParams.get("country")).toBe("AR");
    expect(ramp.searchParams.get("chain")).toBe("42220");
    expect(ramp.searchParams.get("token")).toBe("WARS");
    expect(Number(ramp.searchParams.get("amount"))).toBeGreaterThan(0);
    expect(ramp.searchParams.get("address")?.toLowerCase()).toBe(payer.address.toLowerCase());
    expect(body.directTransfer).toEqual({
      address: MERCHANT_PAYOUT,
      token: WARS.address,
      symbol: "wARS",
      amount: toBaseUnits("2400", 18).toString(),
      decimals: 18,
    });
  });

  it("a plan that does not match the invoice or uses unknown tokens is refused (no quote stored)", async () => {
    const fx = await setup();
    fx.setSolver((input) => ({
      ok: true,
      plan: planFor(input, fx.clock.now, [
        { token: getAddress("0x000000000000000000000000000000000000dEaD"), amountIn: 1n, kind: PullKind.EIP3009, path: "0x", quotedOut: 0n },
      ]),
    }));
    expect((await quote(fx)).res.status).toBe(422);
    fx.setSolver((input) => ({ ok: true, plan: { ...planFor(input, fx.clock.now), minOut: 1n } }));
    expect((await quote(fx)).res.status).toBe(422);
    // wARS does not support EIP-3009
    fx.setSolver((input) => ({
      ok: true,
      plan: planFor(input, fx.clock.now, [{ token: WARS.address, amountIn: 1n, kind: PullKind.EIP3009, path: "0x", quotedOut: 0n }]),
    }));
    expect((await quote(fx)).res.status).toBe(422);
    expect(await fx.db.select().from(quotes)).toHaveLength(0);
  });

  it("solver outage marker (failed quotes) → 503 retryable, no fallbacks", async () => {
    const fx = await setup();
    fx.setSolver(() => ({ ok: false, reason: "no_route", fallback: "ripio", detail: "no pool path to wARS (7 failed quotes)" }));
    const { res, body } = await quote(fx);
    expect(res.status).toBe(503);
    expect(body).toEqual({ error: "temporarily_unavailable", retryable: true });
  });

  it("solver crash → 503 without leaking details; rate limit → 429", async () => {
    const fx = await setup();
    fx.setSolver(() => {
      throw new Error("RPC_URL=https://secret.example");
    });
    const { res, body } = await quote(fx);
    expect(res.status).toBe(503);
    expect(JSON.stringify(body)).not.toContain("secret");
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await handleQuote(req("POST", { payer: payer.address }), fx.invoiceId, fx.deps)).status;
    expect(last).toBe(429);
  });
});

describe("WS7-2: per-payer / per-invoice limits and revert ban", () => {
  it("per-payer quote limit is independent of the client IP (11th quote of one payer → 429)", async () => {
    const fx = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await handleQuote(req("POST", { payer: payer.address }, { "x-forwarded-for": `10.0.0.${i}` }), fx.invoiceId, fx.deps);
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });

  it("per-invoice quote limit holds across payers and IPs", async () => {
    const fx = await setup();
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const who = privateKeyToAccount(`0x${(i + 1).toString(16).padStart(64, "0")}`).address;
      last = (await handleQuote(req("POST", { payer: who }, { "x-forwarded-for": `10.1.0.${i}` }), fx.invoiceId, fx.deps)).status;
    }
    expect(last).toBe(429);
  });

  it("a payer with 3 recent reverts is refused (quote and submit) until the oldest one leaves the window", async () => {
    const fx = await setup();
    const rows = [0, 1, 2].map((i) => ({
      invoiceId: fx.invoiceId,
      payer: payer.address,
      legs: [],
      status: "failed" as const,
      error: i === 0 ? "simulation_reverted:X" : "tx_reverted:Y",
      updatedAt: new Date(fx.clock.now - 60_000 * (i + 1)),
    }));
    await fx.deps.db.insert(submissions).values(rows);
    const { res, body } = await quote(fx);
    expect(res.status).toBe(429);
    expect(body.error).toBe("payer_blocked");
    expect((body as unknown as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
    // another payer is unaffected
    expect((await quote(fx, other.address)).res.status).toBe(200);
    // 31 minutes later the oldest revert is out of the window
    fx.clock.now += 31 * 60_000;
    expect((await quote(fx)).body.error).not.toBe("payer_blocked");
  });
});

describe("POST /api/m/:slug/invoice (static QR)", () => {
  it("creates an open static_qr invoice with amountOut 1:1 in wFIAT base units", async () => {
    const fx = await setup();
    const res = await handleCreateStaticInvoice(req("POST", { amountLocal: "4500,50" }), "cafe-luna", fx.deps);
    expect(res.status).toBe(201);
    const { id, url } = await res.json();
    expect(url).toBe(`/pay/${id}`);
    const [row] = await fx.db.select().from(invoices).where(eq(invoices.id, id));
    expect(row).toMatchObject({
      amountLocal: "4500.5",
      currency: "ARS",
      tokenOut: WARS.address,
      amountOut: (45005n * 10n ** 17n).toString(),
      merchantAddress: MERCHANT_PAYOUT,
      status: "open",
      source: "static_qr",
    });
    expect(row!.expiresAt.getTime()).toBe(T0 + 600_000);
  });

  it("parses strictly", async () => {
    const fx = await setup();
    for (const bad of ["", "0", "0,00", "-5", "1e3", "4.500,00", "4,500.00", "12.345", "abc", " 1 2", 4500, null]) {
      const res = await handleCreateStaticInvoice(req("POST", { amountLocal: bad }, { "x-forwarded-for": `ip-${String(bad)}-${typeof bad}` }), "cafe-luna", fx.deps);
      expect(res.status, String(bad)).toBe(400);
    }
    expect((await handleCreateStaticInvoice(req("POST", { amountLocal: "10" }), "nobody", fx.deps)).status).toBe(404);
  });

  it("refuses a USD-settled merchant (no 1:1 rule)", async () => {
    const fx = await setup({ settlement: USDC.address, slug: "usd-shop" });
    const res = await handleCreateStaticInvoice(req("POST", { amountLocal: "10" }), "usd-shop", fx.deps);
    expect(res.status).toBe(422);
  });
});

describe("Ripio on-ramp on no_route", () => {
  it("no pool to the invoice token (definitive) → 422 with the prefilled Ripio link", async () => {
    const fx = await setup();
    fx.setSolver(() => ({ ok: false, reason: "no_route", fallback: "ripio", detail: "no pool path to wARS" }));
    const { res, body } = await quote(fx);
    expect(res.status).toBe(422);
    expect(body.error).toBe("no_route");
    expect(new URL(body.rampUrl!).searchParams.get("token")).toBe("WARS");
  });
});

describe("Ripio on-ramp link", () => {
  it("prefills AR/BR/MX/CO on Celo, none for wCLP/wPEN, amount rounded up to cents", async () => {
    const { buildRipioOnrampUrl, rampAmount } = await import("../lib/ramp");
    expect(rampAmount(10n ** 18n * 1500n, 18)).toBe("1500");
    expect(rampAmount(10n ** 18n * 15n + 1n, 18)).toBe("15.01");
    const mx = new URL(buildRipioOnrampUrl({ symbol: "wMXN", amount: 10n ** 18n * 200n, decimals: 18 })!);
    expect([mx.searchParams.get("country"), mx.searchParams.get("chain"), mx.searchParams.get("token"), mx.searchParams.get("amount")]).toEqual(["MX", "42220", "WMXN", "200"]);
    expect(mx.searchParams.has("address")).toBe(false);
    expect(new URL(buildRipioOnrampUrl({ symbol: "wCOP", amount: 1n, decimals: 18 })!).searchParams.get("country")).toBe("CO");
    expect(buildRipioOnrampUrl({ symbol: "wCLP", amount: 1n, decimals: 18 })).toBeNull();
    expect(buildRipioOnrampUrl({ symbol: "wPEN", amount: 1n, decimals: 18 })).toBeNull();
  });
});
