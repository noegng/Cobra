import type { Metadata } from "next";
import { DemoApp } from "../../components/demo/demo-app";
import { DEMO } from "../../components/demo/demo-i18n";
import { LangSwitch } from "../../components/lang-switch";
import { TELEGRAM_BOT_URL } from "../../components/telegram-fab";
import { requestLanguage } from "../../lib/server/lang";
import "../landing.css";
import "./demo.css";

export const dynamic = "force-dynamic";

const NAV = {
  es: { home: "Inicio", proof: "Pagos reales" },
  pt: { home: "Início", proof: "Pagamentos reais" },
  en: { home: "Home", proof: "Real payments" },
} as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = DEMO[await requestLanguage("es")];
  return { title: t.meta_title, description: t.meta_desc, robots: { index: true, follow: true } };
}

export default async function DemoPage() {
  const lang = await requestLanguage("es");
  return (
    <div className="lp">
      <header className="lp-nav">
        <a className="lp-logo" href="/">
          <span className="lp-mark" aria-hidden="true">C</span> Cobrá
        </a>
        <nav className="lp-links" aria-label="Cobrá">
          <a href="/">{NAV[lang].home}</a>
          <a href="/proof">{NAV[lang].proof}</a>
        </nav>
        <div className="lp-nav-end">
          <LangSwitch lang={lang} />
        </div>
      </header>
      <main>
        <DemoApp lang={lang} telegramUrl={TELEGRAM_BOT_URL} />
      </main>
    </div>
  );
}
