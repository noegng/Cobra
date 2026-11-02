import { describe, expect, it, vi } from "vitest";
import { Api } from "grammy";
import type { Notifier } from "@cobra/shared";
import { withOperatorChat } from "../src/index";

describe("withOperatorChat", () => {
  it("routes the operator chat id to the raw Telegram API and merchant ids to the base notifier", async () => {
    const base: Notifier = { invoicePaid: vi.fn(async () => {}), text: vi.fn(async () => {}) };
    const calls: { method: string; chat_id: unknown }[] = [];
    const api = new Api("123:abc");
    api.config.use(async (_prev, method, payload) => {
      calls.push({ method, chat_id: (payload as { chat_id?: unknown }).chat_id });
      return { ok: true, result: true } as never; // offline: never hits Telegram
    });
    const n = withOperatorChat(base, { token: "123:abc", operatorChatId: "-1001", api });
    await n.text("-1001", "low gas");
    await n.text("merchant-uuid", "hello");
    expect(calls).toEqual([{ method: "sendMessage", chat_id: "-1001" }]);
    expect(base.text).toHaveBeenCalledTimes(1);
    expect(base.text).toHaveBeenCalledWith("merchant-uuid", "hello");
  });

  it("returns the base notifier unchanged without an operator chat", () => {
    const base: Notifier = { invoicePaid: async () => {}, text: async () => {} };
    expect(withOperatorChat(base, { token: "t" })).toBe(base);
  });
});
