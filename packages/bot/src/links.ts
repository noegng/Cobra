import QRCode from "qrcode";
import type { Language } from "@cobra/shared";

const base = (publicBaseUrl: string) => publicBaseUrl.replace(/\/+$/, "");

export const payUrl = (publicBaseUrl: string, invoiceId: string) => `${base(publicBaseUrl)}/pay/${invoiceId}`;
export const staticPayUrl = (publicBaseUrl: string, slug: string) => `${base(publicBaseUrl)}/pay/m/${slug}`;
/** TODO(WS5): page where the merchant signs a message to prove payout address ownership (optional). */
export const proofUrl = (publicBaseUrl: string, slug: string) => `${base(publicBaseUrl)}/m/${slug}/verify`;

/** WhatsApp share link (no phone number: the merchant picks the contact). */
export const waShareUrl = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;

/** QR code as PNG bytes. */
export async function qrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, { type: "png", width: 512, margin: 2, errorCorrectionLevel: "M" });
}

/**
 * Ripio off-ramp link builder (docs/research/onchain-verification.md §9).
 *
 * Ripio has NO public prefilled ramp link: the widget needs a session token (`_to`) minted server-side with
 * B2B partner credentials, and a partner account is tied to one country. So:
 *   - env RIPIO_PARTNER unset, or no session token minter -> returns null and the bot gives honest manual steps;
 *   - otherwise -> `https://b2b-widget-onramp.ripio.com/offramp.html?_to=<token>&_la=<lang>` (only documented params).
 * We deliberately do not guess `_net` (Celo identifier undocumented) or `_crypto` for wARS/wBRL.
 */
export interface RipioSessionMinter {
  /** Mints a widget session token for this merchant (server-side, partner OAuth2). Not implemented in v1. */
  mint(args: { merchantId: string; country: string }): Promise<string>;
}

const RIPIO_LANG: Record<Language, string> = { es: "es", pt: "br", en: "en" };

export async function buildRipioOfframpLink(args: {
  env: Record<string, string | undefined>;
  minter?: RipioSessionMinter;
  merchantId: string;
  country: string;
  language: Language;
}): Promise<string | null> {
  if (!args.env.RIPIO_PARTNER || !args.minter) return null;
  const token = await args.minter.mint({ merchantId: args.merchantId, country: args.country });
  const host = args.env.RIPIO_SANDBOX === "true" ? "b2b-widget-onramp.sandbox.ripio.com" : "b2b-widget-onramp.ripio.com";
  const q = new URLSearchParams({ _to: token, _la: RIPIO_LANG[args.language] });
  return `https://${host}/offramp.html?${q.toString()}`;
}
