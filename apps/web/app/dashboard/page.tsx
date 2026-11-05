import type { Metadata } from "next";
import { explorerTx } from "@cobra/shared";
import { formatDecimal } from "../../lib/amount";
import { verifyDashboardToken } from "@cobra/shared/dashboard-token";
import { DICTS, isLang, localeFor, type Dict } from "../../lib/i18n";
import { loadDashboard } from "../../lib/server/dashboard";
import { isVerified } from "../../lib/server/verify-server";
import { getDb } from "../../lib/server/deps";
import { requestLanguage } from "../../lib/server/lang";
import { LangSwitch } from "../../components/lang-switch";
import { fiatName } from "../../lib/units";
import "../landing.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cobrá · Panel", referrer: "no-referrer" };

const ROWS_TITLE = { es: "Tus cobros", pt: "Suas cobranças", en: "Your payment requests" } as const;

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ t?: string | string[] }> }) {
  const sp = await searchParams;
  const token = typeof sp.t === "string" ? sp.t : null;
  const claims = verifyDashboardToken(token, process.env.DASHBOARD_SECRET);
  const data = claims ? await loadDashboard(getDb(), claims.merchantId, Date.now()) : null;
  const verified = data ? await isVerified(getDb(), data.merchant.id, data.merchant.payoutAddress) : false;
  const lang = await requestLanguage(data && isLang(data.merchant.language) ? data.merchant.language : "es");
  const t = DICTS[lang];
  const header = (
    <header className="sn">
      <a className="sn-logo" href="/" aria-label="Cobrá">
        <img src="/logo-192.png" alt="Cobrá" width={36} height={36} />
        <span>Cobrá</span>
      </a>
      <span className="db-crumb">{t.dashboard}</span>
      <div className="sn-prefs" style={{ marginLeft: "auto" }}>
        <LangSwitch lang={lang} />
      </div>
    </header>
  );
  if (!data || !token) {
    return (
      <div className="lp">
        {header}
        <main className="pf">
          <section className="ticket db-expired" role="alert">
            <p className="label">{t.dashboard}</p>
            <p>{t.link_expired}</p>
          </section>
        </main>
      </div>
    );
  }
  const locale = localeFor(lang, data.merchant.currency);
  const ccy = data.totals.currency;
  const statusLabel = (s: string) => t[`status_${s}` as keyof Dict] ?? s;
  return (
    <div className="lp">
      {header}
      <main className="pf">
        <header className="pf-head">
          <p className="label">{t.dashboard} · {ccy} · {fiatName(ccy, lang)}</p>
          <h1>{data.merchant.displayName ?? "—"}</h1>
          <p className="mono small break muted">
            {data.merchant.payoutAddress}
            {verified ? <span className="badge paid db-verified">✓ {t.verify_verified}</span> : null}
          </p>
        </header>
        <section className="tiles">
          <div className="card tile">
            <p className="small">{t.totals_today}</p>
            <p className="v">{formatDecimal(data.totals.todayPaidTotal, locale)} <span className="ccy">{ccy}</span></p>
            <p className="small muted">× {data.totals.todayPaidCount}</p>
          </div>
          <div className="card tile">
            <p className="small">{t.totals_all}</p>
            <p className="v">{formatDecimal(data.totals.paidTotal, locale)} <span className="ccy">{ccy}</span></p>
            <p className="small muted">× {data.totals.paidCount}</p>
          </div>
          <div className="card tile">
            <p className="small">{t.open_invoices}</p>
            <p className="v">{data.totals.openCount}</p>
          </div>
        </section>
        <section className="card">
          <div className="db-bar">
            <h2>{ROWS_TITLE[lang]}</h2>
            <a className="sn-btn sn-demo" href={`/api/dashboard/csv?t=${encodeURIComponent(token)}`} download>
              ↓ {t.export_csv}
            </a>
          </div>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t.date}</th>
                  <th scope="col">{t.reference}</th>
                  <th scope="col">{t.amount}</th>
                  <th scope="col">{t.status}</th>
                  <th scope="col">{t.tx}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.createdAt.toLocaleString(locale, { timeZone: data.merchant.timezone, dateStyle: "short", timeStyle: "short" })}</td>
                    <td>
                      {r.reference ?? ""}
                      {r.description ? <span className="db-desc"> · {r.description}</span> : null}
                    </td>
                    <td>{formatDecimal(r.amountLocal, locale)} {r.currency}</td>
                    <td><span className={`badge ${r.status}`}>{statusLabel(r.status)}</span></td>
                    <td>{r.txHash ? <a href={explorerTx(r.txHash)} target="_blank" rel="noopener noreferrer">Celoscan ↗</a> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
