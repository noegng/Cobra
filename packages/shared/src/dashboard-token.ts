/**
 * Short-lived, HMAC-signed merchant dashboard links: `${PUBLIC_BASE_URL}/dashboard?t=<token>`.
 *
 * Import from "@cobra/shared/dashboard-token" (node:crypto, server-side only: kept out of the main barrel so client bundles stay clean).
 * THE BOT CALLS:
 *   signDashboardToken({ merchantId }, process.env.DASHBOARD_SECRET!)          // default TTL 15 min
 *   → `${publicBaseUrl}/dashboard?t=${encodeURIComponent(token)}`
 *
 * Format (dependency-free, reimplementable in ~10 lines if the bot cannot import this file):
 *   payload = base64url(JSON.stringify({ v: 1, m: <merchant uuid>, exp: <unix seconds> }))
 *   sig     = base64url(HMAC-SHA256(secret, "cobra-dashboard.v1." + payload))
 *   token   = payload + "." + sig
 * Secret: env DASHBOARD_SECRET (≥ 32 random bytes), shared by Vercel (verify) and the bot process (sign).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const DASHBOARD_TOKEN_DEFAULT_TTL_S = 15 * 60;
export const DASHBOARD_TOKEN_MAX_TTL_S = 24 * 60 * 60;
const DOMAIN = "cobra-dashboard.v1.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DashboardClaims {
  merchantId: string;
  /** unix seconds */
  exp: number;
}

function assertSecret(secret: string | undefined): asserts secret is string {
  if (!secret || secret.length < 32) throw new Error("DASHBOARD_SECRET missing or too short (need >= 32 chars)");
}

function mac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(DOMAIN + payload).digest("base64url");
}

export function signDashboardToken(
  args: { merchantId: string; ttlSeconds?: number; now?: number },
  secret: string | undefined,
): string {
  assertSecret(secret);
  if (!UUID_RE.test(args.merchantId)) throw new Error("merchantId must be a uuid");
  const ttl = Math.min(Math.max(1, Math.floor(args.ttlSeconds ?? DASHBOARD_TOKEN_DEFAULT_TTL_S)), DASHBOARD_TOKEN_MAX_TTL_S);
  const nowS = Math.floor((args.now ?? Date.now()) / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, m: args.merchantId, exp: nowS + ttl })).toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

/** Returns the claims, or null if the token is malformed, forged or expired. Never throws on bad input. */
export function verifyDashboardToken(token: unknown, secret: string | undefined, now = Date.now()): DashboardClaims | null {
  if (!secret || secret.length < 32) return null;
  if (typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  const expected = Buffer.from(mac(secret, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const c = claims as { v?: unknown; m?: unknown; exp?: unknown };
  if (c.v !== 1 || typeof c.m !== "string" || !UUID_RE.test(c.m) || typeof c.exp !== "number") return null;
  if (c.exp <= Math.floor(now / 1000)) return null;
  if (c.exp > Math.floor(now / 1000) + DASHBOARD_TOKEN_MAX_TTL_S) return null;
  return { merchantId: c.m, exp: c.exp };
}
