/** Floating "talk to the agent" button (landing + proof pages; never on payer pages). */
import type { Language } from "@cobra/shared";

export const TELEGRAM_BOT_URL = "https://t.me/cobra_agent_telegram_bot";

const LABEL: Record<Language, string> = {
  es: "Hablar con el agente",
  pt: "Falar com o agente",
  en: "Talk to the agent",
};

export function TelegramFab({ lang }: { lang: Language }) {
  return (
    <a className="tg-fab" href={TELEGRAM_BOT_URL} target="_blank" rel="noopener noreferrer" aria-label={`${LABEL[lang]} (Telegram)`}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path
          fill="currentColor"
          d="M21.94 4.3a1 1 0 0 0-1.33-1.12L2.7 10.1a1 1 0 0 0 .06 1.89l4.5 1.43 1.73 5.4a1 1 0 0 0 1.66.4l2.5-2.47 4.43 3.27a1 1 0 0 0 1.57-.59l2.8-15.13ZM9.8 13.9l-.62 3.27-1.1-3.44 9.2-5.86-7.48 6.03Z"
        />
      </svg>
      <span>{LABEL[lang]}</span>
    </a>
  );
}
