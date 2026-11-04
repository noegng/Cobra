import type { Metadata } from "next";
import { DemoApp } from "../../components/demo/demo-app";
import { DEMO } from "../../components/demo/demo-i18n";
import { SiteNav } from "../../components/site-nav";
import { TELEGRAM_BOT_URL } from "../../components/telegram-fab";
import { requestLanguage } from "../../lib/server/lang";
import "../landing.css";
import "./demo.css";

export const dynamic = "force-dynamic";


export async function generateMetadata(): Promise<Metadata> {
  const t = DEMO[await requestLanguage("es")];
  return { title: t.meta_title, description: t.meta_desc, robots: { index: true, follow: true } };
}

export default async function DemoPage() {
  const lang = await requestLanguage("es");
  return (
    <div className="lp">
      <SiteNav lang={lang} page="demo" />
      <main>
        <DemoApp lang={lang} telegramUrl={TELEGRAM_BOT_URL} />
      </main>
    </div>
  );
}
