import { createPublicClient, http } from "viem";
import { celo } from "viem/chains";
import { CELO } from "@cobra/shared";
import { apiError, clientIp, json, logEvent, readJsonBody, SLUG_RE } from "../../../../../lib/server/http";
import { getDb } from "../../../../../lib/server/deps";
import { checkSignature, issueNonce, type VerifyDeps } from "../../../../../lib/server/verify-server";
import { createMemoryRateLimiter } from "../../../../../lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Own limiter instance (the shared one is not mine to edit): 10 requests / minute / IP.
const limiter = createMemoryRateLimiter({ verify: { limit: 10, windowMs: 60_000 } });

let verifyMessage: VerifyDeps["verifyMessage"] | null = null;
function deps(): VerifyDeps {
  if (!verifyMessage) {
    const client = createPublicClient({ chain: celo, transport: http(process.env.RPC_URL || CELO.rpcUrl) });
    verifyMessage = (args) => client.verifyMessage(args);
  }
  return { db: getDb(), now: () => Date.now(), verifyMessage };
}

function domainOf(req: Request): string {
  return req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || new URL(req.url).host;
}

function guard(req: Request, slug: string): Response | null {
  if (!SLUG_RE.test(slug)) return apiError(404, "not_found");
  const wait = limiter.hit("verify", clientIp(req));
  if (wait > 0) return apiError(429, "rate_limited", { retryAfter: wait });
  return null;
}

/** GET: issues a nonce and the exact message to sign. */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const blocked = guard(req, slug);
  if (blocked) return blocked;
  const r = await issueNonce(deps(), slug, domainOf(req));
  if (!r) return apiError(404, "not_found");
  return json({ nonce: r.nonce, message: r.message, expiresAt: r.expiresAt });
}

/** POST { nonce, signature }: verifies the signature against the merchant's payout address. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const blocked = guard(req, slug);
  if (blocked) return blocked;
  const body = await readJsonBody(req);
  if (!body) return apiError(400, "bad_request");
  const out = await checkSignature(deps(), slug, domainOf(req), body.nonce, body.signature);
  logEvent("merchant_verify", { slug, outcome: out });
  if (out === "ok") return json({ ok: true });
  const status = out === "not_found" ? 404 : out === "bad_request" ? 400 : out === "nonce_invalid" ? 409 : 422;
  return apiError(status, out);
}
