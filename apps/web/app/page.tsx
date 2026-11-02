import { DICTS } from "../lib/i18n";
import { requestLanguage } from "../lib/server/lang";
import { LangSwitch } from "../components/lang-switch";

export const dynamic = "force-dynamic";

export default async function Home() {
  const lang = await requestLanguage();
  return (
    <main className="wrap">
      <div className="topbar">
        <span className="brand">Cobrá</span>
        <LangSwitch lang={lang} />
      </div>
      <section className="card">
        <p>{DICTS[lang].home_tagline}</p>
      </section>
    </main>
  );
}
