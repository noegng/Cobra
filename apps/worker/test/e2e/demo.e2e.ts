/**
 * Replays the filmed demo across packages on an anvil fork of Celo mainnet. See docs/testing-e2e.md.
 * Skips (never fails) when anvil or the fork RPC is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEther, type Hex } from "viem";
import { PullKind, deserializePlan, explorerTx, serializeLeg, tokenBySymbol, type SerializedPlan } from "@cobra/shared";
import { invoices, onchainInvoiceFromRow, submissions } from "@cobra/db";
import { buildLegSigning, buildSignedLegs } from "../../../web/lib/server/signing";
import { hydrateTypedData } from "../../../web/lib/wire";
import {
  ATTRIBUTION_CODE,
  DEPLOYED_ROUTER,
  accounts,
  apiInvoice,
  apiQuote,
  apiStatus,
  apiSubmit,
  balanceOf,
  charge,
  hasAnvil,
  invoiceRow,
  onboardMerchant,
  paymentOf,
  probeForkSource,
  sendPermit2Approval,
  setTokenBalance,
  signQuote,
  startForkedAnvil,
  startStack,
  submissionsOf,
  suffixOf,
  waitFor,
  MERCHANT_TG_ID,
  BR_MERCHANT,
  type Anvil,
  type Stack,
} from "./harness";

const head = hasAnvil ? await probeForkSource() : null;
const ready = head !== null;
if (!ready) console.warn("[e2e] skipped: needs the `anvil` binary and a reachable Celo RPC (E2E_FORK_URL, default https://forno.celo.org)");

const BR_TG_ID = 4343;
const ZERO_ADDRESS_TOKENS = ["USDT", "USDC", "wARS", "wBRL"] as const;
const E18 = 10n ** 18n;

describe.skipIf(!ready)("end-to-end on a Celo mainnet fork", () => {
  let anvil: Anvil;
  let s: Stack;

  beforeAll(async () => {
    anvil = await startForkedAnvil(head!);
    s = await startStack(anvil);
    await onboardMerchant(s, "AR");
    await onboardMerchant(s, "BR", BR_TG_ID, BR_MERCHANT);
  });
  afterAll(async () => {
    await s?.stop();
    await anvil?.stop();
  });

  const dump = () => s.logs.slice(-15).join("\n");

  /** Waits for the full chain relayer -> chain -> indexer -> DB, and returns the on-chain tx. */
  async function waitPaid(invoiceId: string) {
    try {
      await waitFor("invoice paid", async () => (await invoiceRow(s, invoiceId)).status === "paid", 60_000);
    } catch (e) {
      throw new Error(`${(e as Error).message}\nsubmissions: ${JSON.stringify(await submissionsOf(s, invoiceId))}\nlogs:\n${dump()}`);
    }
    const payment = (await paymentOf(s, invoiceId))!;
    expect(payment).toBeTruthy();
    const tx = await anvil.publicClient.getTransaction({ hash: payment.txHash as Hex });
    return { payment, tx };
  }

  it("onboarding through the bot stored an Argentine merchant paid in wARS", async () => {
    const { db } = s;
    const rows = await db.query.merchants.findMany();
    const ar = rows.find((m) => Number(m.telegramUserId) === MERCHANT_TG_ID)!;
    expect(ar).toMatchObject({ country: "AR", currency: "ARS", settlementToken: tokenBySymbol("wARS")!.address, payoutAddress: accounts.merchant.address });
    expect(s.messagesTo(MERCHANT_TG_ID).some((m) => m.includes("/pay/m/"))).toBe(true); // static QR + link
  });

  it("scene 2: `cobrar 100 prueba`, payer holds only USD₮ (no CELO) and signs once (EIP-3009)", async () => {
    const payer = accounts.payerUsdt;
    const usdt = tokenBySymbol("USDT")!;
    await setTokenBalance(anvil, "USDT", payer.address, 5n * 10n ** BigInt(usdt.decimals));
    await anvil.test.setBalance({ address: payer.address, value: 0n }); // gasless for the payer
    const merchantBefore = await balanceOf(anvil, "wARS", accounts.merchant.address);

    const { invoice, caption } = await charge(s, "cobrar 100 prueba");
    expect(invoice).toMatchObject({ status: "open", currency: "ARS", amountOut: (100n * E18).toString(), merchantAddress: accounts.merchant.address });
    expect(caption).toContain(`/pay/${invoice.id}`);
    expect((await apiInvoice(s, invoice.id)).status).toBe("open");

    const q = await apiQuote(s, invoice.id, payer.address);
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.router).toBe(DEPLOYED_ROUTER);
    expect(q.body.toSign).toHaveLength(1);
    expect(q.body.toSign[0]).toMatchObject({ kind: "EIP3009", symbol: "USDT" });
    expect(q.body.needsPermit2Approval).toEqual([]);
    const amountIn = BigInt(q.body.toSign[0]!.amountIn);

    const sigs = await signQuote(payer, q.body);
    const sub = await apiSubmit(s, invoice.id, q.body.quoteId, sigs);
    expect(sub.status, JSON.stringify(sub.body)).toBe(202);

    const { payment, tx } = await waitPaid(invoice.id);

    // exact amount to the merchant, surplus refunded, nothing stuck in the router
    expect((await balanceOf(anvil, "wARS", accounts.merchant.address)) - merchantBefore).toBe(100n * E18);
    expect(payment.amountOut).toBe((100n * E18).toString());
    const spent = 5n * 10n ** 6n - (await balanceOf(anvil, "USDT", payer.address));
    expect(spent).toBeGreaterThan(0n);
    expect(spent).toBeLessThanOrEqual(amountIn);
    expect(await balanceOf(anvil, "USDT", DEPLOYED_ROUTER)).toBe(0n);
    expect(await balanceOf(anvil, "wARS", DEPLOYED_ROUTER)).toBe(0n);
    expect(await anvil.publicClient.getBalance({ address: payer.address })).toBe(0n);

    // relayed by the agent, ERC-8021 tagged
    expect(tx.from.toLowerCase()).toBe(accounts.relayer.address.toLowerCase());
    expect(tx.to?.toLowerCase()).toBe(DEPLOYED_ROUTER.toLowerCase());
    expect(tx.input.toLowerCase().endsWith(suffixOf(ATTRIBUTION_CODE).slice(2).toLowerCase())).toBe(true);
    expect(ATTRIBUTION_CODE).toBe("celo_502e1bea2794");

    // DB + API state
    const subs = await submissionsOf(s, invoice.id);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.status).toBe("confirmed");
    expect(subs[0]!.txHash).toBe(payment.txHash);
    expect(payment.payer.toLowerCase()).toBe(payer.address.toLowerCase());
    const st = await apiStatus(s, invoice.id);
    expect(st).toMatchObject({ status: "paid", txHash: payment.txHash, explorerUrl: explorerTx(payment.txHash as Hex) });

    // Telegram notification "pagado" to the merchant, with the receipt link
    const notif = await waitFor("paid notification", async () => s.messagesTo(MERCHANT_TG_ID).find((m) => m.includes("Pago recibido")));
    expect(notif).toContain(invoice.reference ?? "");
    expect(notif).toContain("wARS");
    expect(notif).toContain(payment.txHash);
  });

  it("scene 3: `cobrar 1000 café`, payer holds wARS and 0 CELO -> gas grant -> Permit2 approval -> signature -> paid", async () => {
    const payer = accounts.payerWars;
    await setTokenBalance(anvil, "wARS", payer.address, 5_000n * E18);
    await anvil.test.setBalance({ address: payer.address, value: 0n });
    const merchantBefore = await balanceOf(anvil, "wARS", accounts.merchant.address);

    const { invoice } = await charge(s, "cobrar 1000 café");
    expect(invoice.amountOut).toBe((1000n * E18).toString());

    // First quote: wARS has no EIP-3009, the leg is a Permit2 signature but the approval is missing.
    const q1 = await apiQuote(s, invoice.id, payer.address);
    expect(q1.status, JSON.stringify(q1.body)).toBe(200);
    expect(q1.body.toSign[0]).toMatchObject({ kind: "PERMIT2", symbol: "wARS" });
    expect(q1.body.needsPermit2Approval).toEqual([tokenBySymbol("wARS")!.address]);

    // The worker grants gas: exactly 0.05 CELO, ERC-8021 tagged, once.
    await waitFor("gas grant", async () => (await anvil.publicClient.getBalance({ address: payer.address })) > 0n, 30_000);
    expect(await anvil.publicClient.getBalance({ address: payer.address })).toBe(parseEther("0.05"));
    const flagKey = `gas_grant:${payer.address.toLowerCase()}`;
    const flag = (await s.db.query.flags.findMany()).find((f) => f.key === flagKey);
    expect(flag?.value).toMatchObject({ status: "sent", invoiceId: invoice.id });
    const grantTx = await anvil.publicClient.getTransaction({ hash: (flag!.value as { txHash: Hex }).txHash });
    expect(grantTx.value).toBe(parseEther("0.05"));
    expect(grantTx.input.toLowerCase()).toBe(suffixOf(ATTRIBUTION_CODE).toLowerCase());

    // The one-time Permit2 approval, sent by the payer; then the quote becomes a pure signature.
    await sendPermit2Approval(anvil, payer, tokenBySymbol("wARS")!.address);
    const q2 = await apiQuote(s, invoice.id, payer.address);
    expect(q2.status, JSON.stringify(q2.body)).toBe(200);
    expect(q2.body.needsPermit2Approval).toEqual([]);
    expect(q2.body.toSign[0]).toMatchObject({ kind: "PERMIT2" });
    expect(q2.body.toSign[0]!.amountIn).toBe((1000n * E18).toString()); // same token: 1:1, no swap

    const sub = await apiSubmit(s, invoice.id, q2.body.quoteId, await signQuote(payer, q2.body));
    expect(sub.status, JSON.stringify(sub.body)).toBe(202);

    const { payment, tx } = await waitPaid(invoice.id);
    expect((await balanceOf(anvil, "wARS", accounts.merchant.address)) - merchantBefore).toBe(1000n * E18);
    expect(await balanceOf(anvil, "wARS", payer.address)).toBe(4_000n * E18);
    expect(tx.from.toLowerCase()).toBe(accounts.relayer.address.toLowerCase());
    expect(tx.input.toLowerCase().endsWith(suffixOf(ATTRIBUTION_CODE).slice(2).toLowerCase())).toBe(true);
    expect(payment.amountOut).toBe((1000n * E18).toString());
    await waitFor("second paid notification", async () => s.messagesTo(MERCHANT_TG_ID).filter((m) => m.includes("Pago recibido")).length >= 2);
  });

  it("two-leg split: neither USDC nor USD₮ alone covers the invoice, both are pulled with EIP-3009", async () => {
    const payer = accounts.payerSplit;
    await setTokenBalance(anvil, "USDC", payer.address, 400_000n); // 0.40 USDC
    await setTokenBalance(anvil, "USDT", payer.address, 400_000n); // 0.40 USD₮
    await anvil.test.setBalance({ address: payer.address, value: 0n });
    const merchantBefore = await balanceOf(anvil, "wARS", accounts.merchant.address);

    const { invoice } = await charge(s, "cobrar 1000 dos monedas");
    const q = await apiQuote(s, invoice.id, payer.address);
    if (q.status !== 200) throw new Error(`no split plan: ${JSON.stringify(q.body)}`);
    expect(q.body.toSign.map((e) => e.symbol).sort()).toEqual(["USDC", "USDT"]);
    expect(q.body.toSign.every((e) => e.kind === "EIP3009")).toBe(true);
    const sigs = await signQuote(payer, q.body);
    expect(sigs).toHaveLength(2);
    expect((await apiSubmit(s, invoice.id, q.body.quoteId, sigs)).status).toBe(202);

    const { tx } = await waitPaid(invoice.id);
    expect((await balanceOf(anvil, "wARS", accounts.merchant.address)) - merchantBefore).toBe(1000n * E18);
    expect(tx.input.toLowerCase().endsWith(suffixOf(ATTRIBUTION_CODE).slice(2).toLowerCase())).toBe(true);
    for (const sym of ["USDC", "USDT"] as const) expect(await balanceOf(anvil, sym, DEPLOYED_ROUTER)).toBe(0n);
  });

  it("USD₮ -> wBRL for a Brazilian merchant (Portuguese notification)", async () => {
    const payer = accounts.payerBrl;
    await setTokenBalance(anvil, "USDT", payer.address, 5n * 10n ** 6n);
    const before = await balanceOf(anvil, "wBRL", BR_MERCHANT);

    const { invoice } = await charge(s, "cobrar 10 pão", BR_TG_ID);
    expect(invoice).toMatchObject({ currency: "BRL", tokenOut: tokenBySymbol("wBRL")!.address });
    const q = await apiQuote(s, invoice.id, payer.address);
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.toSign[0]).toMatchObject({ kind: "EIP3009", symbol: "USDT" });
    expect((await apiSubmit(s, invoice.id, q.body.quoteId, await signQuote(payer, q.body))).status).toBe(202);

    await waitPaid(invoice.id);
    expect((await balanceOf(anvil, "wBRL", BR_MERCHANT)) - before).toBe(10n * E18);
    const notif = await waitFor("BR notification", async () => s.messagesTo(BR_TG_ID).find((m) => m.includes("Pagamento recebido")));
    expect(notif).toContain("wBRL");
  });

  describe("negative: tampered submissions pay nothing", () => {
    it("a signature over a tampered amount or nonce is rejected by the API; no submission, invoice stays open", async () => {
      const payer = accounts.payerUsdt;
      await setTokenBalance(anvil, "USDT", payer.address, 5n * 10n ** 6n);
      const { invoice } = await charge(s, "cobrar 100 manipulado");
      const merchantBefore = await balanceOf(anvil, "wARS", accounts.merchant.address);
      const attackerBefore = await balanceOf(anvil, "wARS", accounts.attacker.address);

      const q = await apiQuote(s, invoice.id, payer.address);
      expect(q.status).toBe(200);
      const entry = q.body.toSign[0]!;
      const td = hydrateTypedData(entry.typedData!) as { message: Record<string, unknown> } & Parameters<typeof payer.signTypedData>[0];

      const inflated = { ...td, message: { ...td.message, value: (td.message.value as bigint) + 1n } };
      const otherNonce = { ...td, message: { ...td.message, nonce: `0x${"ab".repeat(32)}` } };
      for (const bad of [inflated, otherNonce]) {
        const sig = await payer.signTypedData(bad as Parameters<typeof payer.signTypedData>[0]);
        const res = await apiSubmit(s, invoice.id, q.body.quoteId, [sig]);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("bad_signature");
      }
      // and a signature from somebody else
      const forged = await accounts.attacker.signTypedData(td as Parameters<typeof payer.signTypedData>[0]);
      expect((await apiSubmit(s, invoice.id, q.body.quoteId, [forged])).body.error).toBe("bad_signature");

      expect(await submissionsOf(s, invoice.id)).toHaveLength(0);
      expect((await invoiceRow(s, invoice.id)).status).toBe("open");
      expect(await paymentOf(s, invoice.id)).toBeNull();
      expect(await balanceOf(anvil, "wARS", accounts.merchant.address)).toBe(merchantBefore);
      expect(await balanceOf(anvil, "wARS", accounts.attacker.address)).toBe(attackerBefore);
    });

    it("a valid signature replayed against a tampered invoice (merchant swapped in the DB) is refused by the relayer", async () => {
      const payer = accounts.payerUsdt;
      const { invoice } = await charge(s, "cobrar 100 desvio");
      const q = await apiQuote(s, invoice.id, payer.address);
      expect(q.status).toBe(200);
      const sigs = await signQuote(payer, q.body);

      // Build what the API would have queued, then insert it BEHIND the API's back after changing the merchant.
      const plan = deserializePlan(q.body.plan as SerializedPlan);
      const signing = buildLegSigning({ router: DEPLOYED_ROUTER, chainId: 42220, permit2: s.deps.permit2, invoice: onchainInvoiceFromRow(await invoiceRow(s, invoice.id)), payer: payer.address, legs: plan.legs });
      const legs = buildSignedLegs(plan.legs, signing, sigs);
      expect(legs[0]!.kind).toBe(PullKind.EIP3009);

      const merchantBefore = await balanceOf(anvil, "wARS", accounts.merchant.address);
      const attackerBefore = await balanceOf(anvil, "wARS", accounts.attacker.address);
      const payerBefore = await balanceOf(anvil, "USDT", payer.address);
      const tamper = await s.db.update(invoices).set({ merchantAddress: accounts.attacker.address }).returning({ id: invoices.id });
      expect(tamper.length).toBeGreaterThan(0); // no drizzle `eq` here: rewrites every row, the earlier invoices are final anyway
      const [row] = await s.db.insert(submissions).values({ invoiceId: invoice.id, quoteId: q.body.quoteId, payer: payer.address, legs: legs.map(serializeLeg), status: "pending" }).returning();

      const done = await waitFor("relayer verdict", async () => {
        const cur = (await submissionsOf(s, invoice.id)).find((r) => r.id === row!.id)!;
        return cur.status === "pending" || cur.status === "sending" ? null : cur;
      }, 30_000);
      expect(done.status).toBe("failed");
      expect(done.error).toMatch(/signature/); // verifyLegs: the signature no longer binds this merchant ("leg0:signature_not_payer")
      expect(await paymentOf(s, invoice.id)).toBeNull();
      expect((await invoiceRow(s, invoice.id)).status).not.toBe("paid");
      expect(await balanceOf(anvil, "wARS", accounts.merchant.address)).toBe(merchantBefore);
      expect(await balanceOf(anvil, "wARS", accounts.attacker.address)).toBe(attackerBefore);
      expect(await balanceOf(anvil, "USDT", payer.address)).toBe(payerBefore); // the payer's funds never moved
    });
  });

  it("covers the tokens the scenes rely on (guard against registry drift)", () => {
    for (const sym of ZERO_ADDRESS_TOKENS) expect(tokenBySymbol(sym)?.verified).toBe(true);
  });
});
