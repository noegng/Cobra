import { explorerAddress, explorerTx, tokenByAddress } from "@cobra/shared";
import type { Language } from "@cobra/shared";
import type { ProofStats } from "@cobra/db/queries";
import { formatUnits } from "../lib/amount";
import { DICTS, localeFor } from "../lib/i18n";

export const identityUrl = (agent: string) => `https://www.8004scan.io/search?q=${encodeURIComponent(agent)}`;

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

/** Pure presentation of DB-derived numbers; no hand-typed figures. */
export function ProofView({ stats, lang, agentAddress, routerAddress }: { stats: ProofStats; lang: Language; agentAddress: string | null; routerAddress: string | null }) {
  const t = DICTS[lang];
  const locale = localeFor(lang);
  const sym = (a: string) => tokenByAddress(a)?.symbol ?? short(a);
  const amt = (a: string, v: string) => formatUnits(v, tokenByAddress(a)?.decimals ?? 18, locale);
  return (
    <>
      <p className="small">{t.proof_intro}</p>
      <section className="tiles" aria-label={t.proof_title}>
        <div className="card tile"><div className="small">{t.proof_payments}</div><div className="v" data-testid="count">{stats.paymentCount}</div></div>
        <div className="card tile"><div className="small">{t.proof_payers}</div><div className="v" data-testid="payers">{stats.distinctPayers}</div></div>
        <div className="card tile"><div className="small">{t.proof_merchants}</div><div className="v" data-testid="merchants">{stats.merchantCount}</div></div>
        <div className="card tile">
          <div className="small">{t.proof_savings}</div>
          <div className="v" data-testid="savings">{stats.avgSavingsBps == null ? "—" : `${(stats.avgSavingsBps / 100).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`}</div>
        </div>
      </section>
      <section className="card">
        <h2>{t.proof_volume}</h2>
        {stats.volumeByToken.length === 0 ? <p className="small">—</p> : (
          <ul>
            {stats.volumeByToken.map((v) => (
              <li key={v.tokenOut}>{sym(v.tokenOut)}: {amt(v.tokenOut, v.amountOut)} ({v.count})</li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <h2>{t.proof_recent}</h2>
        {stats.recent.length === 0 ? <p className="small" data-testid="empty">{t.proof_empty}</p> : (
          <div className="scroll">
            <table>
              <thead><tr><th scope="col">{t.date}</th><th scope="col">{t.proof_payer}</th><th scope="col">{t.amount}</th><th scope="col">{t.tx}</th></tr></thead>
              <tbody>
                {stats.recent.map((p) => (
                  <tr key={`${p.txHash}:${p.logIndex}`}>
                    <td>{p.paidAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                    <td>{short(p.payer)}</td>
                    <td>{amt(p.tokenOut, p.amountOut)} {sym(p.tokenOut)}</td>
                    <td><a href={explorerTx(p.txHash)} target="_blank" rel="noreferrer noopener" aria-label={t.proof_view_tx}>{short(p.txHash)}</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <h2>{t.proof_agent}</h2>
        <p className="small">{t.proof_agent_wallet}: {agentAddress ? <a href={explorerAddress(agentAddress)} target="_blank" rel="noreferrer noopener">{agentAddress}</a> : t.proof_unset}</p>
        <p className="small">{t.proof_router}: {routerAddress ? <a href={explorerAddress(routerAddress)} target="_blank" rel="noreferrer noopener">{routerAddress}</a> : t.proof_unset}</p>
        <p className="small">{agentAddress ? <a href={identityUrl(agentAddress)} target="_blank" rel="noreferrer noopener">{t.proof_identity}</a> : `${t.proof_identity}: ${t.proof_unset}`}</p>
      </section>
    </>
  );
}
