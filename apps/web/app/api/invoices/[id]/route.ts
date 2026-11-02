import { handleGetInvoice } from "../../../../lib/server/api";
import { getApiDeps } from "../../../../lib/server/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleGetInvoice(req, (await ctx.params).id, getApiDeps());
}
