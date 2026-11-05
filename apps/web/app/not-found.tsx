/** Branded 404: same header as the site, a short message in the visitor's language, and the three ways back. */
import type { Metadata } from "next";
import { requestLanguage } from "../lib/server/lang";
import { SiteNav } from "../components/site-nav";
import "./landing.css";

export const metadata: Metadata = { title: "Cobrá · 404" };

const T = {
  es: { h1: "Esta página no existe.", sub: "Puede que el enlace esté incompleto o que el cobro ya no exista.", home: "Volver al inicio", demo: "Probar la demo", proof: "Ver pagos reales" },
  pt: { h1: "Esta página não existe.", sub: "Pode ser que o link esteja incompleto ou que a cobrança não exista mais.", home: "Voltar ao início", demo: "Testar a demo", proof: "Ver pagamentos reais" },
  en: { h1: "This page doesn't exist.", sub: "The link may be incomplete, or the payment request may no longer exist.", home: "Back to home", demo: "Try the demo", proof: "See real payments" },
} as const;

export default async function NotFound() {
  const lang = await requestLanguage("es");
  const t = T[lang];
  return (
    <div className="lp">
      <SiteNav lang={lang} page="home" />
      <main>
        <section className="lp-section">
          <p className="lp-eyebrow">404</p>
          <h1>{t.h1}</h1>
          <p className="lp-lead">{t.sub}</p>
          <div className="lp-ctas">
            <a className="lp-btn" href="/">
              {t.home} →
            </a>
            <a className="lp-btn lp-btn-ghost" href="/demo">
              {t.demo}
            </a>
            <a className="lp-btn lp-btn-ghost" href="/proof">
              {t.proof}
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
