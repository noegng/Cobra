import type { Metadata } from "next";
import { getAddress, isAddress } from "viem";
import { proofStats } from "@cobra/db/queries";
import { getDb } from "../../lib/server/deps";
import { requestLanguage } from "../../lib/server/lang";
import { DICTS } from "../../lib/i18n";
import { LangSwitch } from "../../components/lang-switch";
import { ProofView } from "../../components/proof-view";
import agentCard from "../../public/.well-known/agent-registration.json";

/** ERC-8004 agentId from the served agent card (single source of truth, written by `pnpm agent:register`). */
const AGENT_ID: number | null = (agentCard.registrations as { agentId?: number }[])[0]?.agentId ?? null;

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cobrá · Proof" };

const envAddr = (name: string) => {
  const v = process.env[name];
  return v && isAddress(v, { strict: false }) ? getAddress(v) : null;
};

export default async function Proof() {
  const lang = await requestLanguage("es");
  const stats = await proofStats(getDb());
  return (
    <main className="wrap wide">
      <div className="topbar">
        <span className="brand">Cobrá · {DICTS[lang].proof_title}</span>
        <LangSwitch lang={lang} />
      </div>
      <ProofView stats={stats} lang={lang} agentAddress={envAddr("AGENT_ADDRESS")} routerAddress={envAddr("ROUTER_ADDRESS")} agentId={AGENT_ID} />
    </main>
  );
}
