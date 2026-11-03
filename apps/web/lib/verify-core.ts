/** Wallet-ownership proof: the plain-text EIP-191 message, shared by the page (shows it) and the server (rebuilds it). */
export const VERIFY_NONCE_TTL_MS = 10 * 60_000;
export const VERIFY_NONCE_RE = /^[0-9a-f]{32}$/;

export interface VerifyMessageInput {
  slug: string;
  payoutAddress: string;
  domain: string;
  nonce: string;
  expiresAt: number; // epoch ms
}

export function buildVerifyMessage(i: VerifyMessageInput): string {
  return [
    "Cobrá: wallet ownership proof",
    "This signature does not send any transaction and does not move funds.",
    `Domain: ${i.domain}`,
    `Merchant: ${i.slug}`,
    `Payout address: ${i.payoutAddress}`,
    `Nonce: ${i.nonce}`,
    `Expires: ${new Date(i.expiresAt).toISOString()}`,
  ].join("\n");
}
