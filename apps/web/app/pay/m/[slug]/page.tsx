import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { merchants } from "@cobra/db";
import { isLang } from "../../../../lib/i18n";
import { getDb } from "../../../../lib/server/deps";
import { SLUG_RE } from "../../../../lib/server/http";
import { requestLanguage } from "../../../../lib/server/lang";
import { LangSwitch } from "../../../../components/lang-switch";
import { StaticAmountForm } from "../../../../components/static-amount-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cobrá · Pagar", referrer: "no-referrer" };

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) notFound();
  const [m] = await getDb()
    .select({ displayName: merchants.displayName, currency: merchants.currency, language: merchants.language })
    .from(merchants)
    .where(eq(merchants.staticSlug, slug));
  if (!m) notFound();
  const lang = await requestLanguage(isLang(m.language) ? m.language : "es");
  return (
    <main className="wrap">
      <header className="top">
        <span className="sub">{m.displayName?.trim() || "Cobrá"}</span>
      </header>
      <StaticAmountForm slug={slug} currency={m.currency} lang={lang} />
      <footer className="foot">
        <LangSwitch lang={lang} />
      </footer>
    </main>
  );
}
