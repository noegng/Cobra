/**
 * @cobra/bot — WS4. Telegram bot (grammY) + LLM agent with tools (plan §3, §7).
 * FROZEN public signatures below; internals are yours.
 * The webhook route in apps/web just calls `createBot(...)` and grammY's `webhookCallback`.
 */
import type { Db } from "@cobra/db";
import type { Notifier } from "@cobra/shared";

export interface BotOptions {
  token: string;
  db: Db;
  anthropicApiKey: string;
  /** Public base URL of the web app, e.g. https://cobra.example — used for /pay/<id> links. */
  publicBaseUrl: string;
  /** Optional speech-to-text for voice notes. */
  transcribe?: (audio: ArrayBuffer, mime: string) => Promise<string>;
}

/** Returns a configured grammY `Bot` (typed loosely here to keep the stub dependency-free). */
export function createBot(_opts: BotOptions): unknown {
  throw new Error("not implemented (WS4)");
}

export function createTelegramNotifier(_opts: { token: string; db: Db }): Notifier {
  throw new Error("not implemented (WS4)");
}

/** Daily close (21:00 merchant local time by default): totals + CSV. Idempotent per merchant/day. */
export async function runDailyClose(_opts: { db: Db; notifier: Notifier; now: Date }): Promise<void> {
  throw new Error("not implemented (WS4)");
}

/** Reminders for unpaid open invoices (with share link). */
export async function runReminders(_opts: { db: Db; notifier: Notifier; now: Date; publicBaseUrl: string }): Promise<void> {
  throw new Error("not implemented (WS4)");
}
