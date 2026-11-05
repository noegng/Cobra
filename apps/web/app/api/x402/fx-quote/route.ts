import { getFxQuoteDeps } from "../../../../lib/server/deps";
import { handleFxQuote } from "../../../../lib/server/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Facilitator verify + two Uniswap quotes + facilitator settle. */
export const maxDuration = 30;

export async function GET(req: Request) {
  return handleFxQuote(req, getFxQuoteDeps());
}
