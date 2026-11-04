/**
 * Public landing page. Server component: no client JS beyond the language switch.
 * Live numbers come from the DB (same source as /proof); when the DB is unreachable the strip is hidden.
 */
import type { Language } from "@cobra/shared";
import { explorerAddress } from "@cobra/shared";
import { SiteNav } from "./site-nav";
import { LANDING } from "./landing-i18n";
import { TELEGRAM_BOT_URL, TelegramFab } from "./telegram-fab";

export const TELEGRAM_URL = TELEGRAM_BOT_URL;
export const REPO_URL = "https://github.com/noegng/Cobra";

export interface LandingStats {
  paymentCount: number;
  distinctPayers: number;
  merchantCount: number;
}

/** Decorative QR-like pattern (not scannable on purpose): 3 finder squares + seeded modules. */
function FakeQr() {
  const n = 25;
  let seed = 0x2f6b;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const inFinder = (x: number, y: number) => (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!inFinder(x, y) && rnd() > 0.52) cells.push([x, y]);
  const finder = (x: number, y: number) => (
    <g key={`f${x}-${y}`}>
      <rect x={x} y={y} width={7} height={7} fill="currentColor" />
      <rect x={x + 1} y={y + 1} width={5} height={5} fill="var(--lp-card)" />
      <rect x={x + 2} y={y + 2} width={3} height={3} fill="currentColor" />
    </g>
  );
  return (
    <svg className="lp-qr" viewBox={`-1 -1 ${n + 2} ${n + 2}`} aria-hidden="true" shapeRendering="crispEdges">
      <rect x={-1} y={-1} width={n + 2} height={n + 2} fill="var(--lp-card)" />
      {finder(0, 0)}
      {finder(n - 7, 0)}
      {finder(0, n - 7)}
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" />
      ))}
    </svg>
  );
}

function PhoneMock({ t }: { t: (typeof LANDING)["es"] }) {
  return (
    <div className="lp-visual" aria-hidden="true">
      <div className="lp-phone">
        <div className="lp-phone-bar">
          <img className="lp-avatar" src="/logo-192.png" alt="" width={30} height={30} />
          <span>
            <b>Cobrá</b>
            <small>bot</small>
          </span>
        </div>
        <div className="lp-chat">
          <p className="lp-bubble lp-me lp-a1">{t.mock_user}</p>
          <div className="lp-bubble lp-bot lp-a2">
            <FakeQr />
            <p className="lp-pre">{t.mock_invoice}</p>
            <span className="lp-kb">{t.mock_share}</span>
          </div>
          <p className="lp-bubble lp-bot lp-paid lp-a4">{t.mock_paid}</p>
        </div>
      </div>
      <div className="lp-paycard lp-a3">
        <small>{t.mock_payer_merchant}</small>
        <span className="lp-paycard-amt">{t.mock_amount}</span>
        <small>{t.mock_amount_unit}</small>
        <span className="lp-paycard-btn">{t.mock_payer_btn}</span>
        <small>{t.mock_payer_note}</small>
      </div>
    </div>
  );
}

export function Landing({
  lang,
  stats,
  agentId,
  routerAddress,
  legacyRouterAddress = null,
}: {
  lang: Language;
  stats: LandingStats | null;
  agentId: number | null;
  routerAddress: string;
  /** Previous (v1) router, listed next to the active one after a router switch. */
  legacyRouterAddress?: string | null;
}) {
  const t = LANDING[lang];
  const nf = new Intl.NumberFormat(lang === "pt" ? "pt-BR" : lang === "en" ? "en-US" : "es-AR");
  return (
    <div className="lp">
      <SiteNav lang={lang} page="home" />

      <main>
        <section className="lp-hero">
          <div className="lp-hero-text">
            <p className="lp-eyebrow">{t.eyebrow}</p>
            <h1>
              {t.h1_a}
              <br />
              <span className="lp-accent">{t.h1_b}</span>
            </h1>
            <p className="lp-lead">{t.lead}</p>
            <div className="lp-ctas">
              <a className="lp-btn" href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">
                {t.cta_start} →
              </a>
              <a className="lp-btn lp-btn-ghost" href="/demo">
                {t.cta_demo}
              </a>
              <a className="lp-btn lp-btn-ghost" href="/proof">
                {t.cta_proof}
              </a>
            </div>
            <ul className="lp-pills">
              {t.pills.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
          <PhoneMock t={t} />
        </section>

        {stats && stats.paymentCount > 0 && (
          <section className="lp-stats" aria-label={t.nav_proof}>
            <div>
              <b>{nf.format(stats.paymentCount)}</b>
              <span>{t.stats_payments}</span>
            </div>
            <div>
              <b>{nf.format(stats.distinctPayers)}</b>
              <span>{t.stats_payers}</span>
            </div>
            <div>
              <b>{nf.format(stats.merchantCount)}</b>
              <span>{t.stats_merchants}</span>
            </div>
            <a href="/proof">{t.stats_link} →</a>
          </section>
        )}

        <section id="how" className="lp-section">
          <h2>{t.how_title}</h2>
          <ol className="lp-steps">
            {t.how.map(([title, body], i) => (
              <li key={title}>
                <span className="lp-num">{i + 1}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="merchants" className="lp-section">
          <h2>{t.merchants_title}</h2>
          <p className="lp-sub">{t.merchants_sub}</p>
          <div className="lp-grid">
            {t.merchants.map(([title, body]) => (
              <article key={title} className="lp-card">
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="payers" className="lp-section">
          <h2>{t.payers_title}</h2>
          <p className="lp-sub">{t.payers_sub}</p>
          <div className="lp-grid lp-grid-4">
            {t.payers.map(([title, body]) => (
              <article key={title} className="lp-card">
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="trust" className="lp-section lp-dark">
          <h2>{t.trust_title}</h2>
          <p className="lp-sub">{t.trust_sub}</p>
          <div className="lp-grid lp-grid-4">
            {t.trust.map(([title, body]) => (
              <article key={title} className="lp-card">
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
          <a className="lp-more" href={explorerAddress(routerAddress)} target="_blank" rel="noopener noreferrer">
            {t.trust_link} ↗
          </a>
        </section>

        <section id="agent" className="lp-section lp-agent">
          <div>
            <h2>{t.agent_title}</h2>
            <p className="lp-sub">{t.agent_sub}</p>
          </div>
          <ul className="lp-checks">
            {t.agent.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="lp-agent-id">
            {agentId != null && (
              <a href={`https://8004scan.io/agents/celo/${agentId}`} target="_blank" rel="noopener noreferrer">
                {t.agent_id.replace("{id}", String(agentId))} ↗
              </a>
            )}
            <a href="/proof#journal">{t.agent_journal} →</a>
          </p>
        </section>

        <section className="lp-section">
          <h2>{t.countries_title}</h2>
          <div className="lp-countries">
            {t.countries.map(([country, token, status]) => (
              <div key={country} className="lp-country">
                <b>{country}</b>
                <span className="lp-token">{token}</span>
                <span className="lp-status">{status}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="lp-final">
          <h2>{t.final_title}</h2>
          <p>{t.final_sub}</p>
          <a className="lp-btn" href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">
            {t.cta_start} →
          </a>
        </section>
      </main>

      <footer className="lp-foot">
        <span>Cobrá · Celo mainnet</span>
        <nav aria-label="Links">
          <a href="/demo">{t.nav_demo}</a>
          <a href="/proof">{t.nav_proof}</a>
          <a href="/api/agent/journal">{t.foot_journal}</a>
          <a href="/.well-known/agent-registration.json">{t.foot_card}</a>
          <a href={explorerAddress(routerAddress)} target="_blank" rel="noopener noreferrer">CobraRouter</a>
          {legacyRouterAddress && (
            <a href={explorerAddress(legacyRouterAddress)} target="_blank" rel="noopener noreferrer">CobraRouter v1</a>
          )}
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">{t.foot_code}</a>
        </nav>
      </footer>
      <TelegramFab lang={lang} />
    </div>
  );
}
