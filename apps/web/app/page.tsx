import type { Metadata } from "next";
import { getAddress, isAddress } from "viem";
import { proofStats } from "@cobra/db/queries";
import { Landing, type LandingStats } from "../components/landing";
import { LANDING } from "../components/landing-i18n";
import { getDb } from "../lib/server/deps";
import { requestLanguage } from "../lib/server/lang";
import agentCard from "../public/.well-known/agent-registration.json";
import "./landing.css";

export const dynamic = "force-dynamic";

/** Deployed CobraRouter (README); ROUTER_ADDRESS overrides it. */
const DEFAULT_ROUTER = "0xfe38683105fa36ee664acefe7e714ba93492e458";
const AGENT_ID: number | null = (agentCard.registrations as { agentId?: number }[])[0]?.agentId ?? null;

export async function generateMetadata(): Promise<Metadata> {
  const t = LANDING[await requestLanguage("es")];
  return {
    title: t.meta_title,
    description: t.meta_desc,
    robots: { index: true, follow: true },
    openGraph: { title: t.meta_title, description: t.meta_desc, type: "website", siteName: "Cobrá" },
  };
}

async function liveStats(): Promise<LandingStats | null> {
  try {
    const s = await proofStats(getDb(), 1);
    return { paymentCount: s.paymentCount, distinctPayers: s.distinctPayers, merchantCount: s.merchantCount };
  } catch {
    return null; // the landing page must render even when the DB is unreachable
  }
}

export default async function Home() {
  const lang = await requestLanguage("es");
  const env = process.env.ROUTER_ADDRESS;
  const router = env && isAddress(env, { strict: false }) ? getAddress(env) : getAddress(DEFAULT_ROUTER);
  const legacyEnv = process.env.LEGACY_ROUTER_ADDRESS;
  const legacy = legacyEnv && isAddress(legacyEnv, { strict: false }) ? getAddress(legacyEnv) : null;
  return <Landing lang={lang} stats={await liveStats()} agentId={AGENT_ID} routerAddress={router} legacyRouterAddress={legacy} />;
}
