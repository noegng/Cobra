import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { merchants } from "@cobra/db";
import { isLang } from "../../../../lib/i18n";
import { getDb } from "../../../../lib/server/deps";
import { SLUG_RE } from "../../../../lib/server/http";
import { requestLanguage } from "../../../../lib/server/lang";
import { isVerified } from "../../../../lib/server/verify-server";
import { LangSwitch } from "../../../../components/lang-switch";
import { VerifyView } from "../../../../components/verify-view";
import { WalletProvider } from "../../../../components/wallet-provider";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cobrá · Verificar", referrer: "no-referrer" };

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) notFound();
  const db = getDb();
  const [m] = await db
    .select({ id: merchants.id, displayName: merchants.displayName, payoutAddress: merchants.payoutAddress, language: merchants.language })
    .from(merchants)
    .where(eq(merchants.staticSlug, slug));
  if (!m) notFound();
  const lang = await requestLanguage(isLang(m.language) ? m.language : "es");
  const verified = await isVerified(db, m.id, m.payoutAddress);
  return (
    <WalletProvider>
      <main className="wrap">
        <header className="top">
          <span className="sub">{m.displayName?.trim() || "Cobrá"}</span>
        </header>
        <VerifyView slug={slug} payoutAddress={m.payoutAddress} alreadyVerified={verified} lang={lang} />
        <footer className="foot">
          <LangSwitch lang={lang} />
        </footer>
      </main>
    </WalletProvider>
  );
}
