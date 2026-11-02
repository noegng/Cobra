/** Deterministic rendering helpers shared by the bot, the agent tools and the schedulers. */
import type { InvoiceRow } from "@cobra/db";
import type { InvoiceStatus, Language } from "@cobra/shared";
import { amountStyleFor, formatAmount } from "./amount";
import { statusLabel, t } from "./i18n";
import { payUrl, waShareUrl } from "./links";
import type { MerchantRow } from "./merchants";

export const merchantLang = (m: Pick<MerchantRow, "language">): Language =>
  m.language === "pt" || m.language === "en" ? m.language : "es";

export function money(m: Pick<MerchantRow, "country" | "language">, amount: string, currency: string): string {
  return formatAmount(amount, currency, amountStyleFor(m.country, m.language));
}

export function merchantName(m: Pick<MerchantRow, "displayName">): string {
  return m.displayName?.trim() || "Cobrá";
}

export function invoiceLine(m: MerchantRow, inv: InvoiceRow): string {
  const lang = merchantLang(m);
  return t(lang, "invoice_line", {
    ref: inv.reference ?? inv.id.slice(0, 10),
    amount: money(m, inv.amountLocal, inv.currency),
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

export function invoiceCaption(m: MerchantRow, inv: InvoiceRow, publicBaseUrl: string, now: Date): string {
  return t(merchantLang(m), "invoice_caption", {
    ref: inv.reference ?? "",
    amount: money(m, inv.amountLocal, inv.currency),
    desc: inv.description ? ` — ${inv.description}` : "",
    minutes: Math.max(1, Math.round((inv.expiresAt.getTime() - now.getTime()) / 60_000)),
    url: payUrl(publicBaseUrl, inv.id),
  });
}
