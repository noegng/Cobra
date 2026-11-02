import type { Metadata } from "next";
import { explorerTx } from "@cobra/shared";
import { formatDecimal } from "../../lib/amount";
import { verifyDashboardToken } from "../../lib/dashboard-token";
import { DICTS, isLang, localeFor, type Dict } from "../../lib/i18n";
import { loadDashboard } from "../../lib/server/dashboard";
import { getDb } from "../../lib/server/deps";
import { requestLanguage } from "../../lib/server/lang";
import { LangSwitch } from "../../components/lang-switch";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cobrá · Panel", referrer: "no-referrer" };

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ t?: string | string[] }> }) {
  const sp = await searchParams;
  const token = typeof sp.t === "string" ? sp.t : null;
  const claims = verifyDashboardToken(token, process.env.DASHBOARD_SECRET);
  const data = claims ? await loadDashboard(getDb(), claims.merchantId, Date.now()) : null;
  const lang = await requestLanguage(data && isLang(data.merchant.language) ? data.merchant.language : "es");
  const t = DICTS[lang];
  if (!data || !token) {
    return (
      <main className="wrap">
        <section className="card err" role="alert">
          <p>{t.link_expired}</p>
        </section>
      </main>
    );
  }
  const locale = localeFor(lang, data.merchant.currency);
  const ccy = data.totals.currency;
  const statusLabel = (s: string) => t[`status_${s}` as keyof Dict] ?? s;
  return (
    <main className="wrap wide">
      <div className="topbar">
        <span className="brand">Cobrá · {t.dashboard}</span>
        <LangSwitch lang={lang} />
      </div>
      <section className="card">
        <h1 className="merchant">{data.merchant.displayName ?? "—"}</h1>
        <p className="mono small break muted">{data.merchant.payoutAddress}</p>
      </section>
      <section className="tiles">
        <div className="card tile">
          <p className="small muted">{t.totals_today}</p>
          <p className="v">{formatDecimal(data.totals.todayPaidTotal, locale)} {ccy}</p>
          <p className="small muted">× {data.totals.todayPaidCount}</p>
        </div>
        <div className="card tile">
          <p className="small muted">{t.totals_all}</p>
          <p className="v">{formatDecimal(data.totals.paidTotal, locale)} {ccy}</p>
          <p className="small muted">× {data.totals.paidCount}</p>
        </div>
        <div className="card tile">
          <p className="small muted">{t.open_invoices}</p>
          <p className="v">{data.totals.openCount}</p>
        </div>
      </section>
      <section className="card stack">
        <a className="btn" href={`/api/dashboard/csv?t=${encodeURIComponent(token)}`} download>
          {t.export_csv}
        </a>
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
                  <td>{r.reference ?? ""}{r.description ? ` · ${r.description}` : ""}</td>
                  <td>{formatDecimal(r.amountLocal, locale)} {r.currency}</td>
                  <td>{statusLabel(r.status)}</td>
                  <td>{r.txHash ? <a href={explorerTx(r.txHash)} target="_blank" rel="noopener noreferrer">↗</a> : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
