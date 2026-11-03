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
 * Ripio public off-ramp (https://ramp.ripio.com/llms.txt; AR/CO/MX/BR). No partner account needed. URL query
 * params are undocumented, so this is the bare page; the bot adds copy-paste instructions next to it.
 */
export const RIPIO_OFFRAMP_URL = "https://ramp.ripio.com/off-ramp";

/** Single builder for the merchant-side cash-out link. */
export function buildRipioOfframpLink(): string {
  return RIPIO_OFFRAMP_URL;
}
