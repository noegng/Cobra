import QRCode from "qrcode";
import { CELO_CHAIN_ID, COUNTRIES, type Language } from "@cobra/shared";

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
 * Ripio public off-ramp (no partner account). Query params `country`, `chain`, `token` prefill the form (hackathon
 * docs; `/offramp` redirects here keeping them). Ramp countries with Celo: AR, BR, MX, CO (manual check, Plan 3 T9).
 * The bot still adds copy-paste instructions next to the link.
 */
export const RIPIO_OFFRAMP_URL = "https://ramp.ripio.com/off-ramp";
const RAMP_COUNTRIES = ["AR", "BR", "MX", "CO"];

/** Single builder for the merchant-side cash-out link; bare page when the token has no Ripio ramp country. */
export function buildRipioOfframpLink(tokenSymbol?: string): string {
  const c = tokenSymbol ? COUNTRIES.find((x) => x.wfiatSymbol.toLowerCase() === tokenSymbol.toLowerCase()) : undefined;
  if (!c || !RAMP_COUNTRIES.includes(c.country)) return RIPIO_OFFRAMP_URL;
  const q = new URLSearchParams({ country: c.country, chain: String(CELO_CHAIN_ID), token: c.wfiatSymbol.toUpperCase() });
  return `${RIPIO_OFFRAMP_URL}?${q.toString()}`;
}
