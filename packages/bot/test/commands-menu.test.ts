import { Api } from "grammy";
import { describe, expect, it } from "vitest";
import { registerBotCommands } from "../src/bot";
import { t } from "../src/i18n";
import { fakeApi } from "./helpers";

describe("command discoverability", () => {
  it("help lists the panel command in every language", () => {
    expect(t("es", "help", { token: "wARS" })).toContain("/panel");
    expect(t("pt", "help", { token: "wBRL" })).toContain("/painel");
    expect(t("en", "help", { token: "wARS" })).toContain("/dashboard");
  });

  it("help mentions the 10 minute expiry and the 21:00 daily close", () => {
    for (const lang of ["es", "pt", "en"] as const) {
      const h = t(lang, "help", { token: "wARS" });
      expect(h).toContain("10 min");
      expect(h).toContain("21:00");
    }
  });

  it("registerBotCommands registers the panel command per language", async () => {
    const api = new Api("123:fake");
    const calls = fakeApi(api);
    await registerBotCommands(api);
    const byLang = new Map(calls.filter((c) => c.method === "setMyCommands").map((c) => [c.payload.language_code ?? "es", c.payload.commands as Array<{ command: string }>]));
    expect(byLang.get("es")!.map((c) => c.command)).toContain("panel");
    expect(byLang.get("pt")!.map((c) => c.command)).toContain("painel");
    expect(byLang.get("en")!.map((c) => c.command)).toContain("dashboard");
  });
});
