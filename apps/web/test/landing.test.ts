import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
// The language switch needs the Next app router; it is not under test here.
vi.mock("../components/lang-switch", () => ({ LangSwitch: () => null }));

import { Landing, TELEGRAM_URL } from "../components/landing";
import { LANDING } from "../components/landing-i18n";

const ROUTER = "0xfe38683105fa36ee664acefe7e714ba93492e458";
const render = (lang: "es" | "pt" | "en", stats: { paymentCount: number; distinctPayers: number; merchantCount: number } | null) =>
  renderToStaticMarkup(createElement(Landing, { lang, stats, agentId: 10033, routerAddress: ROUTER }));

describe("landing page", () => {
  it.each(["es", "pt", "en"] as const)("%s: CTA to the bot, router link, no unfilled placeholder", (lang) => {
    const html = render(lang, { paymentCount: 2, distinctPayers: 2, merchantCount: 1 });
    expect(html).toContain(TELEGRAM_URL);
    expect(html).toContain(`celoscan.io/address/${ROUTER}`);
    expect(html).toContain("8004scan.io/agents/celo/10033");
    expect(html).not.toMatch(/\{[a-z]+\}/);
    expect(html).toContain(LANDING[lang].h1_b);
    expect(html).toContain(LANDING[lang].stats_payments);
    expect(html).toContain('class="tg-fab"');
  });

  it("lists the legacy v1 router next to the active one when configured", () => {
    const V1 = "0x00000000000000000000000000000000c0b4a000";
    const html = renderToStaticMarkup(createElement(Landing, { lang: "en", stats: null, agentId: 10033, routerAddress: ROUTER, legacyRouterAddress: V1 }));
    expect(html).toContain(`celoscan.io/address/${ROUTER}`);
    expect(html).toContain(`celoscan.io/address/${V1}`);
    expect(render("en", null)).not.toContain("CobraRouter v1");
  });

  it("hides the live strip when the DB is unreachable or empty", () => {
    expect(render("es", null)).not.toContain(LANDING.es.stats_payments);
    expect(render("es", { paymentCount: 0, distinctPayers: 0, merchantCount: 0 })).not.toContain(LANDING.es.stats_payments);
  });

  it("every language has the same shape as Spanish", () => {
    for (const lang of ["pt", "en"] as const) {
      for (const key of Object.keys(LANDING.es) as (keyof typeof LANDING.es)[]) {
        const a = LANDING.es[key];
        const b = LANDING[lang][key];
        expect(Array.isArray(b), `${lang}.${key}`).toBe(Array.isArray(a));
        if (Array.isArray(a) && Array.isArray(b)) expect(b.length, `${lang}.${key}`).toBe(a.length);
      }
    }
  });
});
