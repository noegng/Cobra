/**
 * Telegram webhook, isolated in one file because `createBot` (WS4) is still a stub returning `unknown`.
 * Secret check: header X-Telegram-Bot-Api-Secret-Token must equal TELEGRAM_WEBHOOK_SECRET (constant time),
 * BEFORE the bot is constructed. grammY also re-checks it (`secretToken` option).
 * Set the webhook with: setWebhook(url=<base>/api/telegram, secret_token=<TELEGRAM_WEBHOOK_SECRET>).
 */
import { timingSafeEqual } from "node:crypto";

export type WebhookHandler = (req: Request) => Promise<Response>;

export function secretMatches(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Framework-free handler; `getCallback` builds (and caches) grammY's std/http webhook callback. */
export function createTelegramWebhook(opts: { secret: string | undefined; getCallback: () => Promise<WebhookHandler> }): WebhookHandler {
  return async (req) => {
    if (!opts.secret) return new Response("not configured", { status: 503 });
    if (!secretMatches(req.headers.get("x-telegram-bot-api-secret-token"), opts.secret)) {
      return new Response("unauthorized", { status: 401 });
    }
    let cb: WebhookHandler;
    try {
      cb = await opts.getCallback();
    } catch {
      // e.g. bot not implemented / misconfigured. 503 makes Telegram retry later; no details leaked.
      console.error(JSON.stringify({ event: "telegram.bot_unavailable" }));
      return new Response("bot unavailable", { status: 503 });
    }
    return cb(req);
  };
}

let cached: WebhookHandler | null = null;

/** Production callback: grammY `webhookCallback(createBot({...}), "std/http")`. */
export async function productionCallback(): Promise<WebhookHandler> {
  if (cached) return cached;
  const [{ webhookCallback }, { createBot }, { getDb }] = await Promise.all([
    import("grammy"),
    import("@cobra/bot"),
    import("./deps"),
  ]);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  if (!token || !anthropicApiKey || !publicBaseUrl) throw new Error("telegram env incomplete");
  const bot = createBot({ token, db: getDb(), anthropicApiKey, publicBaseUrl }) as Parameters<typeof webhookCallback>[0];
  cached = webhookCallback(bot, "std/http", { secretToken: process.env.TELEGRAM_WEBHOOK_SECRET }) as WebhookHandler;
  return cached;
}
