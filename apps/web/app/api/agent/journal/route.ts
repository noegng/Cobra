import { getAddress, isAddress } from "viem";
import { getDb } from "../../../../lib/server/deps";
import { handleJournalGet } from "../../../../lib/server/journal-api";
import { apiError } from "../../../../lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = process.env.AGENT_ADDRESS;
  try {
    return await handleJournalGet(req, { db: getDb(), agentAddress: a && isAddress(a, { strict: false }) ? getAddress(a) : null });
  } catch {
    return apiError(503, "temporarily_unavailable");
  }
}
