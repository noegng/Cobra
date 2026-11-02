import { cookies, headers } from "next/headers";
import type { Language } from "@cobra/shared";
import { LANG_COOKIE, negotiateLanguage } from "../i18n";

/** Server components: cookie > Accept-Language > fallback (e.g. the merchant's language). */
export async function requestLanguage(fallback: Language = "es"): Promise<Language> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  return negotiateLanguage(h.get("accept-language"), c.get(LANG_COOKIE)?.value, fallback);
}

export async function requestHost(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-host") ?? h.get("host") ?? "";
}
