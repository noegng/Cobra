"use client";

import { useRouter } from "next/navigation";
import type { Language } from "@cobra/shared";
import { DICTS, LANG_COOKIE, LANGS } from "../lib/i18n";

export function LangSwitch({ lang }: { lang: Language }) {
  const router = useRouter();
  return (
    <label className="small">
      <span className="sr-only">{DICTS[lang].language}</span>
      <select
        value={lang}
        aria-label={DICTS[lang].language}
        onChange={(e) => {
          document.cookie = `${LANG_COOKIE}=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
          router.refresh();
        }}
      >
        {LANGS.map((l) => (
          <option key={l} value={l}>
            {l.toUpperCase()}
          </option>
        ))}
      </select>
    </label>
  );
}
