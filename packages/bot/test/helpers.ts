import type { Api, RawApi } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { MockLanguageModelV4 } from "ai/test";
import { merchants, type Db } from "@cobra/db";
import { createTestDb } from "@cobra/db/testing";
import { tokenBySymbol } from "@cobra/shared";
import { buildBot, type BotDeps } from "../src/bot";
import type { MerchantRow } from "../src/merchants";

export { createTestDb };

export const BASE_URL = "https://cobra.test";
export const TOKEN = "123456:TEST-TOKEN";
// anvil public test addresses (no keys involved)
export const ADDR_A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const ADDR_B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const ATTACKER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

export const BOT_INFO: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: "Cobra",
  username: "cobra_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

let slugN = 0;
export async function seedMerchant(
  db: Db,
  over: Partial<typeof merchants.$inferInsert> & { telegramUserId: bigint } = { telegramUserId: 1n },
): Promise<MerchantRow> {
  const country = over.country ?? "AR";
  const token = tokenBySymbol(country === "BR" ? "wBRL" : "wARS")!;
  const [m] = await db
    .insert(merchants)
    .values({
      telegramChatId: over.telegramUserId,
      displayName: "Kiosco Ana",
      country,
      currency: token.currency,
      settlementToken: token.address,
      payoutAddress: ADDR_A,
      language: country === "BR" ? "pt" : "es",
      staticSlug: `slug-${++slugN}-${over.telegramUserId}`,
      timezone: country === "BR" ? "America/Sao_Paulo" : "America/Argentina/Buenos_Aires",
      ...over,
    })
    .returning();
  return m!;
}

export interface ApiCall {
  method: string;
  payload: Record<string, any>;
}

/** Installs a fake API transformer: records every call, never touches the network. */
export function fakeApi(api: Api<RawApi>): ApiCall[] {
  const calls: ApiCall[] = [];
  let msgId = 100;
  api.config.use(async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, any>;
    calls.push({ method, payload: p });
    let result: unknown = true;
    if (method.startsWith("send")) {
      result = { message_id: ++msgId, date: 0, chat: { id: p.chat_id, type: "private", first_name: "x" }, text: p.text };
    } else if (method === "getFile") {
      result = { file_id: p.file_id, file_unique_id: "u", file_path: "voice/file_1.oga" };
    }
    return { ok: true, result } as any;
  });
  return calls;
}

export const sent = (calls: ApiCall[], method?: string) => calls.filter((c) => !method || c.method === method);
export const texts = (calls: ApiCall[]) => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));

let updateId = 1;
const user = (id: number, language_code = "es") => ({ id, is_bot: false, first_name: "Ana", language_code });

export function textUpdate(userId: number, text: string, opts: { language_code?: string; chatType?: "private" | "group" } = {}): Update {
  const entities = text.startsWith("/") ? [{ type: "bot_command" as const, offset: 0, length: text.split(/\s/)[0]!.length }] : undefined;
  const chat = opts.chatType === "group" ? { id: -5, type: "group" as const, title: "g" } : { id: userId, type: "private" as const, first_name: "Ana" };
  return {
    update_id: updateId++,
    message: { message_id: updateId, date: 0, chat, from: user(userId, opts.language_code), text, ...(entities ? { entities } : {}) },
  } as Update;
}

export function callbackUpdate(userId: number, data: string): Update {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      from: user(userId),
      chat_instance: "ci",
      data,
      message: { message_id: 1, date: 0, chat: { id: userId, type: "private", first_name: "Ana" }, text: "..." },
    },
  } as Update;
}

export function voiceUpdate(userId: number, duration = 5): Update {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: userId, type: "private", first_name: "Ana" },
      from: user(userId),
      voice: { file_id: "voice-1", file_unique_id: "vu", duration, mime_type: "audio/ogg" },
    },
  } as Update;
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

export type MockStep = { tools?: Array<{ name: string; input: unknown }>; text?: string };

/** MockLanguageModelV4 replaying the given steps (one doGenerate result per step). */
export function mockModel(steps: MockStep[]): MockLanguageModelV4 {
  let callId = 0;
  return new MockLanguageModelV4({
    doGenerate: steps.map((s) => ({
      content: [
        ...(s.text ? [{ type: "text" as const, text: s.text }] : []),
        ...(s.tools ?? []).map((tc) => ({
          type: "tool-call" as const,
          toolCallId: `call-${++callId}`,
          toolName: tc.name,
          input: JSON.stringify(tc.input),
        })),
      ],
      finishReason: { unified: s.tools?.length ? ("tool-calls" as const) : ("stop" as const), raw: undefined },
      usage,
      warnings: [],
    })),
  });
}

/** A model that fails the test if it is ever called (fast path must not touch the LLM). */
export function forbiddenModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error("LLM must not be called");
    },
  });
}

export function makeBot(db: Db, deps: BotDeps = {}, transcribe?: (a: ArrayBuffer, m: string) => Promise<string>) {
  const logs: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
  const bot = buildBot(
    { token: TOKEN, db, anthropicApiKey: "", publicBaseUrl: BASE_URL, transcribe },
    // No network in tests: no reference rate by default (no dollar hint, size check "unknown"); tests that need one pass `rates`.
    { botInfo: BOT_INFO, model: null, env: {}, log: (msg, extra) => logs.push({ msg, extra }), rates: async () => ({}), ...deps },
  );
  const calls = fakeApi(bot.api);
  return { bot, calls, logs };
}
