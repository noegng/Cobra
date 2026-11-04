import { handleQuote } from "../../../../../lib/server/api";
import { getApiDeps } from "../../../../../lib/server/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Uniswap quoting + a Textile firm request (up to 8 s) must fit; keep Vercel from cutting the function at its default. */
export const maxDuration = 30;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleQuote(req, (await ctx.params).id, getApiDeps());
}
