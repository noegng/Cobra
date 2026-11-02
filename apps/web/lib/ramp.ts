/**
 * Ripio on-ramp ("Pagar en pesos" / "Pagar em reais").
 *
 * Ripio has NO public prefilled link: the B2B widget needs a server-minted partner token
 * (docs/research/onchain-verification.md §9). So:
 *  - `rampEnabled(env)` is false unless RIPIO_PARTNER is set → the page hides the button;
 *  - `buildRipioOnrampUrl` builds the documented widget URL once a token is available;
 *  - minting the `_to` token (OAuth2 partner credentials) is NOT implemented — plug it in `mintRipioToken`.
 * The honest fallback (always shown) is a direct wFIAT transfer to the merchant's payout address.
 */
export const RIPIO_WIDGET_HOST = "https://b2b-widget-onramp.ripio.com";

export function rampEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.RIPIO_PARTNER);
}

export function buildRipioOnrampUrl(args: {
  token: string;
  address: string;
  /** Fiat amount as decimal string. */
  amount?: string;
  crypto?: string;
  network?: string;
  lang?: "es" | "pt" | "en";
  host?: string;
}): string {
  const u = new URL(args.host ?? RIPIO_WIDGET_HOST);
  u.searchParams.set("_to", args.token);
  u.searchParams.set("_addr", args.address);
  if (args.amount) u.searchParams.set("_amount", args.amount);
  if (args.crypto) u.searchParams.set("_crypto", args.crypto);
  if (args.network) u.searchParams.set("_net", args.network);
  if (args.lang) u.searchParams.set("_la", args.lang === "pt" ? "br" : args.lang);
  return u.toString();
}

/** Placeholder: returns null until the Ripio partner OAuth flow is wired (Bloqué in the WS5 report). */
export async function mintRipioToken(_env: Record<string, string | undefined> = process.env): Promise<string | null> {
  return null;
}

export async function rampUrlFor(
  args: { address: string; amount?: string; crypto?: string; lang?: "es" | "pt" | "en" },
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  if (!rampEnabled(env)) return null;
  const token = await mintRipioToken(env);
  if (!token) return null;
  return buildRipioOnrampUrl({ ...args, token, network: env.RIPIO_NETWORK, host: env.RIPIO_WIDGET_HOST });
}
