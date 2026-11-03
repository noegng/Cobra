/**
 * @cobra/bot — WS4. Telegram bot (grammY) + LLM agent with tools (plan §3, §7).
 * FROZEN public signatures below (createBot return type narrowed from `unknown` to the grammY Bot — compatible).
 * The webhook route in apps/web calls `createWebhookHandler(...)` (or `createBot(...)` + grammY's `webhookCallback`).
 */
import { Api, webhookCallback } from "grammy";
import type { Db } from "@cobra/db";
import type { Notifier } from "@cobra/shared";
import { buildBot, type BotDeps, type BotOptions, type CobraBot } from "./bot";
import { createNotifierWithApi } from "./notifier";
import { runDailyCloseImpl, runRemindersImpl } from "./scheduler";

export type { BotOptions, BotDeps, CobraBot, CobraContext } from "./bot";
export { buildBot, registerBotCommands, COMMANDS } from "./bot";
export { createNotifierWithApi, isBotNotifier, type BotNotifier } from "./notifier";
export { parseAmount, formatAmount, amountStyleFor, type AmountError, type AmountResult, type AmountStyle } from "./amount";
export { matchCharge } from "./fastpath";
export { buildTools, runAgent, systemPrompt, modelFromEnv, DEFAULT_MODEL, ALTERNATIVE_MODEL, TOOL_NAMES } from "./agent";
export { buildRipioOfframpLink, payUrl, staticPayUrl, waShareUrl, qrPng } from "./links";
export { createGroqTranscriber, groqTranscriberFromEnv, type Transcribe } from "./transcribe-groq";
export { REMINDER_LEAD_MS, INVOICE_RATE_LIMIT } from "./invoices";

/** Returns a configured grammY `Bot`. */
export function createBot(opts: BotOptions): CobraBot {
  return buildBot(opts);
}

/**
 * Fetch-style webhook handler for apps/web (Next.js route handler / any std `Request -> Response` runtime).
 * `secretToken` = TELEGRAM_WEBHOOK_SECRET (Telegram sends it in `X-Telegram-Bot-Api-Secret-Token`).
 */
export function createWebhookHandler(
  opts: BotOptions & { secretToken?: string },
  deps: BotDeps = {},
): (req: Request) => Promise<Response> {
  const { secretToken, ...botOpts } = opts;
  const bot = buildBot(botOpts, deps);
  return webhookCallback(bot, "std/http", { secretToken, onTimeout: "return", timeoutMilliseconds: 25_000 });
}

export function createTelegramNotifier(opts: { token: string; db: Db }): Notifier {
  return createNotifierWithApi(new Api(opts.token), opts.db);
}

/**
 * Wraps a merchant notifier so `text(operatorChatId, …)` goes straight to the operator's Telegram chat
 * (Notifier.text otherwise expects a merchant id and would fail to resolve a raw chat id).
 */
export function withOperatorChat(
  notifier: Notifier,
  opts: { token: string; operatorChatId?: string; api?: Api },
): Notifier {
  const op = opts.operatorChatId;
  if (!op) return notifier;
  const api = opts.api ?? new Api(opts.token);
  return Object.assign(Object.create(notifier) as Notifier, notifier, {
    async text(id: string, message: string) {
      if (id === op) {
        await api.sendMessage(op, message, { link_preview_options: { is_disabled: true } });
        return;
      }
      await notifier.text(id, message);
    },
  });
}

/** Daily close (21:00 merchant local time by default): totals + CSV. Idempotent per merchant/day. */
export async function runDailyClose(opts: { db: Db; notifier: Notifier; now: Date }): Promise<void> {
  await runDailyCloseImpl(opts);
}

/** Reminders for unpaid open invoices (with share link). */
export async function runReminders(opts: { db: Db; notifier: Notifier; now: Date; publicBaseUrl: string }): Promise<void> {
  await runRemindersImpl(opts);
}
