/** Deterministic rendering helpers shared by the bot, the agent tools and the schedulers. */
import type { InvoiceRow } from "@cobra/db";
import type { InvoiceStatus, Language } from "@cobra/shared";
import { amountStyleFor, currencyName, formatAmountNamed } from "./amount";
import type { CreateInvoiceError } from "./invoices";
import type { ChargeSize } from "./limits";
import { statusLabel, t } from "./i18n";
import { payUrl, waShareUrl } from "./links";
import type { MerchantRow } from "./merchants";
import { formatUsdCents, isUsdtAddress, USDT_DISPLAY, usdtToken } from "./usd";

export const merchantLang = (m: Pick<MerchantRow, "language">): Language =>
  m.language === "pt" || m.language === "en" ? m.language : "es";

/** "$ 4.500 pesos argentinos": always with the currency written out ("$" alone reads as dollars). */
export function money(m: Pick<MerchantRow, "country" | "language">, amount: string, currency: string): string {
  return formatAmountNamed(amount, currency, amountStyleFor(m.country, m.language), m.language);
}

export function merchantName(m: Pick<MerchantRow, "displayName">): string {
  return m.displayName?.trim() || "Cobrá";
}

/**
 * Invoice amount as the merchant reads it. wFIAT (1:1): "$ 4.500 pesos argentinos". USD₮ settlement:
 * "$ 4.500 pesos argentinos ≈ 2,73 USD₮"
 * (amountOut rounded up to cents, display only; the stored amountOut is exact).
 */
export function invoiceAmount(m: Pick<MerchantRow, "country" | "language">, inv: Pick<InvoiceRow, "amountLocal" | "currency" | "tokenOut" | "amountOut">): string {
  const local = money(m, inv.amountLocal, inv.currency);
  if (!isUsdtAddress(inv.tokenOut)) return local;
  const usd = formatUsdCents(inv.amountOut, usdtToken()!.decimals, amountStyleFor(m.country, m.language));
  return `${local} ≈ ${usd} ${USDT_DISPLAY}`;
}

export function invoiceLine(m: MerchantRow, inv: InvoiceRow): string {
  const lang = merchantLang(m);
  return t(lang, "invoice_line", {
    ref: inv.reference ?? inv.id.slice(0, 10),
    amount: invoiceAmount(m, inv),
    status: statusLabel(lang, inv.status as InvoiceStatus),
    desc: inv.description ? ` · ${inv.description}` : "",
  });
}

export function shareText(m: MerchantRow, inv: InvoiceRow, publicBaseUrl: string): string {
  return t(merchantLang(m), "wa_text", {
    name: merchantName(m),
    amount: money(m, inv.amountLocal, inv.currency),
    desc: inv.description ? ` (${inv.description})` : "",
    url: payUrl(publicBaseUrl, inv.id),
  });
}

export function shareLink(m: MerchantRow, inv: InvoiceRow, publicBaseUrl: string): string {
  return waShareUrl(shareText(m, inv, publicBaseUrl));
}

/**
 * `usdMicro`: dollar value at the reference rate, shown as " (≈ US$ 2,73)" so a unit mix-up is visible at once.
 * Not for USD₮-settled invoices (invoiceAmount already shows what is received) nor without a rate.
 */
export function invoiceCaption(m: MerchantRow, inv: InvoiceRow, publicBaseUrl: string, now: Date, usdMicro: bigint | null = null): string {
  const lang = merchantLang(m);
  return t(lang, "invoice_caption", {
    ref: inv.reference ?? "",
    amount: invoiceAmount(m, inv),
    usd: usdMicro !== null && !isUsdtAddress(inv.tokenOut) ? t(lang, "usd_hint", { usd: usdDisplay(m, usdMicro) }) : "",
    desc: inv.description ? ` — ${inv.description}` : "",
    minutes: Math.max(1, Math.round((inv.expiresAt.getTime() - now.getTime()) / 60_000)),
    url: payUrl(publicBaseUrl, inv.id),
  });
}

/** Dollar value for display: "2,73" / "2.73" (USD micro-units rounded up to cents). */
export function usdDisplay(m: Pick<MerchantRow, "country" | "language">, usdMicro: bigint): string {
  return formatUsdCents(usdMicro, 6, amountStyleFor(m.country, m.language));
}

/** The currency written out for the merchant ("pesos argentinos"). */
export function curName(m: Pick<MerchantRow, "currency" | "language">): string {
  return currencyName(m.currency, m.language);
}

/** Merchant-facing reason a charge was not created (same wording from the fast path and the agent). */
export function createInvoiceErrorMessage(m: MerchantRow, amountLocal: string, res: { error: CreateInvoiceError; size?: ChargeSize }): string {
  const lang = merchantLang(m);
  if (res.error === "over_limit" && res.size && res.size.kind !== "unknown") {
    return t(lang, "charge_over", {
      amount: money(m, amountLocal, m.currency),
      usd: usdDisplay(m, res.size.usdMicro),
      max: String(res.size.maxUsd),
      cur: curName(m),
    });
  }
  const key = res.error === "rate_limited" ? "rate_limited" : res.error === "rate_unavailable" ? "rate_unavailable" : "unsupported_settlement";
  return t(lang, key, { currency: m.currency });
}
