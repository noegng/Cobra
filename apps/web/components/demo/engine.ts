/**
 * Demo engine: deterministic and pure, no network, no wallet, no LLM. It reuses the bot's real amount parser and
 * fast path so "cobrar 4.500,50 pizza" is read exactly as in production. Everything it produces is simulated.
 */
import { amountStyleFor, formatAmount, parseAmount, type AmountError } from "@cobra/bot/amount";
import { matchCharge } from "@cobra/bot/fastpath";
import type { Language } from "@cobra/shared";

export type DemoCountry = "AR" | "BR";

export const DEMO_COUNTRIES: Record<DemoCountry, { currency: "ARS" | "BRL"; token: "wARS" | "wBRL"; merchant: string; route: string; costBps: number; rateMilli: bigint }> = {
  // Illustrative rates (local units per USD₮, ×1000) and measured route costs; labelled "illustrative" in the UI.
  AR: { currency: "ARS", token: "wARS", merchant: "Pizzería Don Luis", route: "USD₮ → wARS · Uniswap V3", costBps: 10, rateMilli: 1_650_000n },
  // BR: today's live route (Uniswap V3, ~3.3% measured). Switch to Textile RFQ (~0.2%) once router v2 is live.
  BR: { currency: "BRL", token: "wBRL", merchant: "Barbearia do Zé", route: "USD₮ → wBRL · Uniswap V3", costBps: 330, rateMilli: 5_486n },
};

/** Simulated payer wallet balance, in USD₮ micro-units (6 decimals). */
export const DEMO_BALANCE_MICRO = 50_000_000n;

export interface DemoInvoice {
  ref: string;
  amount: string; // canonical decimal string from parseAmount, e.g. "4500.5"
  desc: string;
  status: "open" | "paid" | "cancelled";
}

export type MerchantAction =
  | { kind: "charge"; invoice: DemoInvoice }
  | { kind: "amount_error"; error: AmountError; input: string }
  | { kind: "usage" }
  | { kind: "status"; invoice: DemoInvoice | null; ref: string }
  | { kind: "cancel"; invoice: DemoInvoice | null }
  | { kind: "close"; paid: DemoInvoice[]; open: number }
  | { kind: "help" }
  | { kind: "unknown" };

const REF_RE = /\bA-?(\d{1,4})\b/i;

export const nextRef = (n: number) => `A-${String(n).padStart(4, "0")}`;

/** Decimal string → integer cents (bigint). */
export function toCents(amount: string): bigint {
  const [i = "0", f = ""] = amount.split(".");
  return BigInt(i) * 100n + BigInt((f + "00").slice(0, 2));
}

/** What the payer signs, in USD₮ micro-units: amount / rate, plus the route cost, rounded up. */
export function quoteMicro(amount: string, country: DemoCountry): bigint {
  const { rateMilli, costBps } = DEMO_COUNTRIES[country];
  const num = toCents(amount) * 1_000_000n * 1000n * BigInt(10_000 + costBps);
  const den = 100n * rateMilli * 10_000n;
  return (num + den - 1n) / den;
}

/** 2-decimal display of USD₮ micro-units, rounded up so we never under-state what leaves the wallet. */
export function formatUsdt(micro: bigint, lang: Language): string {
  const cents = (micro + 9_999n) / 10_000n;
  const int = (cents / 100n).toString();
  const frac = (cents % 100n).toString().padStart(2, "0");
  return lang === "en" ? `${int}.${frac}` : `${int},${frac}`;
}

export function formatLocal(amount: string, country: DemoCountry, lang: Language): string {
  const { currency } = DEMO_COUNTRIES[country];
  return formatAmount(amount, currency, amountStyleFor(country, lang));
}

export function handleMerchantText(text: string, ctx: { country: DemoCountry; lang: Language; invoices: DemoInvoice[] }): MerchantAction {
  const t = text.trim();
  if (!t) return { kind: "unknown" };
  const charge = matchCharge(t);
  if (charge) {
    if (!charge.amountText) return { kind: "usage" };
    const parsed = parseAmount(charge.amountText, amountStyleFor(ctx.country, ctx.lang));
    if (!parsed.ok) return { kind: "amount_error", error: parsed.error, input: charge.amountText };
    return { kind: "charge", invoice: { ref: nextRef(ctx.invoices.length + 1), amount: parsed.value, desc: charge.description.slice(0, 60), status: "open" } };
  }
  if (/^\/?(ayuda|ajuda|help|start)\b/i.test(t)) return { kind: "help" };
  if (/^\/?(cierre|fechamento|close)\b/i.test(t)) {
    return { kind: "close", paid: ctx.invoices.filter((i) => i.status === "paid"), open: ctx.invoices.filter((i) => i.status === "open").length };
  }
  if (/cancel/i.test(t)) {
    const open = [...ctx.invoices].reverse().find((i) => i.status === "open") ?? null;
    return { kind: "cancel", invoice: open };
  }
  const ref = REF_RE.exec(t);
  if (ref || /pag|paid|status|estado/i.test(t)) {
    const wanted = ref ? nextRef(Number(ref[1])) : null;
    const inv = wanted ? ctx.invoices.find((i) => i.ref === wanted) ?? null : ctx.invoices.at(-1) ?? null;
    return { kind: "status", invoice: inv, ref: wanted ?? inv?.ref ?? "" };
  }
  return { kind: "unknown" };
}
