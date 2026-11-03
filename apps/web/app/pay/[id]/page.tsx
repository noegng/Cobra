import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLang } from "../../../lib/i18n";
import { getDb } from "../../../lib/server/deps";
import { INVOICE_ID_RE } from "../../../lib/server/http";
import { loadInvoice, toPublicInvoice } from "../../../lib/server/invoices";
import { requestLanguage } from "../../../lib/server/lang";
import { PayPage } from "../../../components/pay-page";
import { WalletProvider } from "../../../components/wallet-provider";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cobrá · Pagar", referrer: "no-referrer" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!INVOICE_ID_RE.test(id)) notFound();
  const loaded = await loadInvoice(getDb(), id);
  if (!loaded) notFound();
  const fallback = isLang(loaded.merchant.language) ? loaded.merchant.language : "es";
  const lang = await requestLanguage(fallback);
  const invoice = toPublicInvoice(loaded.invoice, loaded.merchant, Date.now());
  return (
    <WalletProvider>
      <PayPage invoice={invoice} lang={lang} />
    </WalletProvider>
  );
}
