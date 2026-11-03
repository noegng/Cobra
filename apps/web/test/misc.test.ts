import { describe, expect, it } from "vitest";
import { createTelegramWebhook } from "../lib/server/telegram";

const SECRET = "x".repeat(40);
const MID = "3f1e7a52-8d3b-4a5e-9c1d-2b7f6e8a9c01";

describe("telegram webhook", () => {
  it("checks the secret header before building the bot", async () => {
    let built = 0;
    const h = createTelegramWebhook({
      secret: SECRET,
      getCallback: async () => {
        built++;
        return async () => new Response("ok");
      },
    });
    const mk = (tok?: string) =>
      new Request("http://x/api/telegram", { method: "POST", headers: tok ? { "x-telegram-bot-api-secret-token": tok } : {}, body: "{}" });
    expect((await h(mk())).status).toBe(401);
    expect((await h(mk("wrong"))).status).toBe(401);
    expect(built).toBe(0);
    expect(await (await h(mk(SECRET))).text()).toBe("ok");
    const broken = createTelegramWebhook({
      secret: SECRET,
      getCallback: async () => {
        throw new Error("not implemented (WS4)");
      },
    });
    expect((await broken(mk(SECRET))).status).toBe(503);
  });
});
