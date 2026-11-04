import type { Metadata } from "next";
import { getAddress, isAddress } from "viem";
import { proofStats } from "@cobra/db/queries";
import { getDb } from "../../lib/server/deps";
import { requestLanguage } from "../../lib/server/lang";
import { DICTS } from "../../lib/i18n";
import { SiteNav } from "../../components/site-nav";
import { ProofView } from "../../components/proof-view";
import { JournalView } from "../../components/journal-view";
import { TelegramFab } from "../../components/telegram-fab";
import { queryJournal } from "../../lib/server/journal";
import agentCard from "../../public/.well-known/agent-registration.json";
import "../landing.css";

/** ERC-8004 agentId from the served agent card (single source of truth, written by `pnpm agent:register`). */
const AGENT_ID: number | null = (agentCard.registrations as { agentId?: number }[])[0]?.agentId ?? null;

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Cobrá · Proof" };

const HEAD = {
  es: { h1: "Pagos reales en Celo.", sub: "Cada número de esta página sale de la blockchain y cada pago enlaza su transacción en Celoscan. Aquí no hay nada simulado." },
  pt: { h1: "Pagamentos reais na Celo.", sub: "Cada número desta página vem da blockchain e cada pagamento leva à sua transação no Celoscan. Aqui nada é simulado." },
  en: { h1: "Real payments on Celo.", sub: "Every number on this page comes from the blockchain, and every payment links to its transaction on Celoscan. Nothing here is simulated." },
} as const;

const envAddr = (name: string) => {
  const v = process.env[name];
  return v && isAddress(v, { strict: false }) ? getAddress(v) : null;
};

export default async function Proof() {
  const lang = await requestLanguage("es");
  const stats = await proofStats(getDb());
  const journal = await queryJournal(getDb(), { agentAddress: envAddr("AGENT_ADDRESS") });
  return (
    <div className="lp">
      <SiteNav lang={lang} page="proof" />
      <main className="pf">
        <header className="pf-head">
          <p className="label">
            <span className="sn-live pf-live" aria-hidden="true" /> {DICTS[lang].proof_title} · Celo mainnet
          </p>
          <h1>{HEAD[lang].h1}</h1>
          <p className="lp-sub">{HEAD[lang].sub}</p>
        </header>
        <ProofView stats={stats} lang={lang} agentAddress={envAddr("AGENT_ADDRESS")} routerAddress={envAddr("ROUTER_ADDRESS")} agentId={AGENT_ID} />
        <JournalView journal={journal} lang={lang} />
      </main>
      <TelegramFab lang={lang} />
    </div>
  );
}
