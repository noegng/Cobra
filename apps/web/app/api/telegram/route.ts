import { createTelegramWebhook, productionCallback } from "../../../lib/server/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  // env read per request (never at build time); the grammY callback itself is cached.
  return createTelegramWebhook({ secret: process.env.TELEGRAM_WEBHOOK_SECRET, getCallback: productionCallback })(req);
}
