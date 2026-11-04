"use client";

/**
 * Site header shared by the landing, /demo and /proof: logo, a "How it works" dropdown (merchants, customers,
 * security), then the two key actions set apart: Demo and Real payments. Language + theme on the right.
 */
import { useEffect, useRef, useState } from "react";
import type { Language } from "@cobra/shared";
import { LangSwitch } from "./lang-switch";

type Page = "home" | "demo" | "proof";

const NAV: Record<Language, { how: string; how_all: string; merchants: string; payers: string; trust: string; agent: string; demo: string; proof: string; home: string }> = {
  es: { how: "Cómo funciona", how_all: "En tres pasos", merchants: "Para comercios", payers: "Para clientes", trust: "Seguridad", agent: "El agente", demo: "Demo", proof: "Pagos reales", home: "Inicio" },
  pt: { how: "Como funciona", how_all: "Em três passos", merchants: "Para comércios", payers: "Para clientes", trust: "Segurança", agent: "O agente", demo: "Demo", proof: "Pagamentos reais", home: "Início" },
  en: { how: "How it works", how_all: "In three steps", merchants: "For merchants", payers: "For customers", trust: "Security", agent: "The agent", demo: "Demo", proof: "Real payments", home: "Home" },
};

export function SiteNav({ lang, page }: { lang: Language; page: Page }) {
  const t = NAV[lang];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const base = page === "home" ? "" : "/";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const items: Array<[string, string]> = [
    [`${base}#how`, t.how_all],
    [`${base}#merchants`, t.merchants],
    [`${base}#payers`, t.payers],
    [`${base}#trust`, t.trust],
    [`${base}#agent`, t.agent],
  ];

  return (
    <header className="sn">
      <a className="sn-logo" href="/" aria-label={`Cobrá · ${t.home}`}>
        <img src="/logo-192.png" alt="" width={36} height={36} />
        <span>Cobrá</span>
      </a>

      <div className="sn-menu" ref={ref}>
        <button type="button" className="sn-trigger" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((v) => !v)}>
          {t.how}
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        {open && (
          <ul className="sn-drop" role="menu">
            {items.map(([href, label], i) => (
              <li key={href} role="none">
                <a role="menuitem" href={href} onClick={() => setOpen(false)}>
                  <span className="sn-idx">{String(i + 1).padStart(2, "0")}</span>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      <nav className="sn-actions" aria-label="Cobrá">
        <a className={`sn-btn sn-demo ${page === "demo" ? "is-current" : ""}`} href="/demo" aria-current={page === "demo" ? "page" : undefined}>
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
            <path d="M3 1.8v8.4L10 6z" fill="currentColor" />
          </svg>
          {t.demo}
        </a>
        <a className={`sn-btn sn-proof ${page === "proof" ? "is-current" : ""}`} href="/proof" aria-current={page === "proof" ? "page" : undefined}>
          <span className="sn-live" aria-hidden="true" />
          {t.proof}
        </a>
      </nav>

      <div className="sn-prefs">
        <LangSwitch lang={lang} />
      </div>
    </header>
  );
}
