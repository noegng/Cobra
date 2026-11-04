import { explorerAddress, explorerTx } from "@cobra/shared";
import type { Language } from "@cobra/shared";
import { localeFor } from "../lib/i18n";
import { bpsPercent, describeRoute, fmtAmount, shortAddr, type Journal, type RouteEntry } from "../lib/server/journal";
import { JOURNAL } from "./journal-i18n";

const when = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC";
const link = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noreferrer noopener">{text}</a>
);

function Route({ e, lang }: { e: RouteEntry; lang: Language }) {
  const s = JOURNAL[lang];
  const locale = localeFor(lang);
  return (
    <li className="card" data-testid="journal-route">
      <div className="small">{when(e.at)} · <strong>{s.route}</strong> · {link(explorerTx(e.txHash), shortAddr(e.txHash))}</div>
      <p>
        {s.paid_out}: <strong>{fmtAmount(e.amountOut, e.decimalsOut, locale)} {e.symbolOut}</strong>
        {e.amountLocal && e.currency ? <span className="small"> ({s.invoice} {e.amountLocal} {e.currency})</span> : null}
      </p>
      {e.legs.length > 0 && (
        <p className="small">
          {s.signed}: {e.legs.map((l) => `${fmtAmount(l.amountIn, l.decimalsIn, locale)} ${l.symbolIn}`).join(" + ")}
          <br />
          {s.path}: {describeRoute(e.legs)} · {e.split ? s.split.replace("{n}", String(e.legCount)) : s.single}
        </p>
      )}
      <p className="small">
        {e.quotedSurplus != null && <>{s.surplus}: {fmtAmount(e.quotedSurplus, e.decimalsOut, locale)} {e.symbolOut}<br /></>}
        {e.costBps != null && <>{s.cost}: {bpsPercent(e.costBps, locale)} %<br /></>}
        {e.savingsBps != null && <>{s.savings}: {bpsPercent(e.savingsBps, locale)} %<br /></>}
        {e.relayed && e.sender ? <>{s.relayed_by} {link(explorerAddress(e.sender), shortAddr(e.sender))} · {s.tag} {e.attributionTag}</> : s.self_submitted}
      </p>
    </li>
  );
}

/** Pure presentation of the journal (server-rendered, no hand-typed figures). */
export function JournalView({ journal, lang }: { journal: Journal; lang: Language }) {
  const s = JOURNAL[lang];
  const locale = localeFor(lang);
  return (
    <section id="journal" aria-label={s.title} data-testid="journal">
      <h2>{s.title}</h2>
      <p className="small">{s.intro} <a href="/api/agent/journal">{s.json}</a></p>
      {journal.entries.length === 0 ? <p className="small" data-testid="journal-empty">{s.empty}</p> : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {journal.entries.map((e) =>
            e.type === "route" ? <Route key={`r:${e.txHash}`} e={e} lang={lang} /> : (
              <li className="card" key={`g:${e.txHash}`} data-testid="journal-grant">
                <div className="small">{when(e.at)} · <strong>{s.grant_why}</strong> · {link(explorerTx(e.txHash), shortAddr(e.txHash))}</div>
                <p>
                  {(() => {
                    const [a = "", b = ""] = s.grant.replace("{amount}", fmtAmount(e.value, 18, locale, 4)).split("{to}");
                    return <>{a}{link(explorerAddress(e.to), shortAddr(e.to))}{b}</>;
                  })()}
                </p>
                <p className="small">{s.relayed_by} {link(explorerAddress(e.sender), shortAddr(e.sender))} · {s.tag} {e.attributionTag}</p>
              </li>
            ),
          )}
        </ul>
      )}
      {journal.days.length > 0 && (
        <div className="card">
          <h3>{s.daily}</h3>
          <ul>
            {journal.days.map((d) => (
              <li key={d.date} className="small" data-testid="journal-day">
                {d.date}: {d.remindersSent} {s.reminders} · {d.dailyCloses} {s.closes} · {d.failedSubmissions} {s.failed}
              </li>
            ))}
          </ul>
          <p className="small">{s.failed_note}</p>
        </div>
      )}
    </section>
  );
}
