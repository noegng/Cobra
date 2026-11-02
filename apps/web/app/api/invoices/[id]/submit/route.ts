import { handleSubmit } from "../../../../../lib/server/api";
import { getApiDeps } from "../../../../../lib/server/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleSubmit(req, (await ctx.params).id, getApiDeps());
}
