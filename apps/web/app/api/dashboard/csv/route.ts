import { verifyDashboardToken } from "../../../../lib/dashboard-token";
import { dashboardCsv, loadDashboard } from "../../../../lib/server/dashboard";
import { getDb } from "../../../../lib/server/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const t = new URL(req.url).searchParams.get("t");
  const claims = verifyDashboardToken(t, process.env.DASHBOARD_SECRET);
  if (!claims) return new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  const data = await loadDashboard(getDb(), claims.merchantId, Date.now());
  if (!data) return new Response("not found", { status: 404 });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(dashboardCsv(data), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="cobra-${day}.csv"`,
      "cache-control": "no-store",
    },
  });
}
