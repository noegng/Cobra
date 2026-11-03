import { eq } from "drizzle-orm";
import { merchants } from "@cobra/db";
import { verifyDashboardToken } from "@cobra/shared/dashboard-token";
import { dashboardCsv } from "../../../../lib/server/dashboard";
import { getDb } from "../../../../lib/server/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const t = new URL(req.url).searchParams.get("t");
  const claims = verifyDashboardToken(t, process.env.DASHBOARD_SECRET);
  if (!claims) return new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  const db = getDb();
  const [m] = await db.select({ id: merchants.id }).from(merchants).where(eq(merchants.id, claims.merchantId));
  if (!m) return new Response("not found", { status: 404 });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(await dashboardCsv(db, m.id), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="cobra-pagos-${day}.csv"`,
      "cache-control": "no-store",
    },
  });
}
