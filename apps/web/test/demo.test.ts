import { describe, expect, it } from "vitest";
import { DEMO } from "../components/demo/demo-i18n";
import { DEMO_BALANCE_MICRO, formatLocal, formatUsdt, handleMerchantText, quoteMicro, toCents, type DemoInvoice } from "../components/demo/engine";

const ctx = (invoices: DemoInvoice[] = [], lang: "es" | "pt" | "en" = "es") => ({ country: "AR" as const, lang, invoices });

describe("demo engine", () => {
  it("reads charges with the bot's real parser", () => {
    const a = handleMerchantText("cobrar 4.500,50 pizza", ctx());
    expect(a).toEqual({ kind: "charge", invoice: { ref: "A-0001", amount: "4500.5", desc: "pizza", status: "open" } });
    expect(handleMerchantText("cobrar 2 mil café", ctx()).kind).toBe("charge");
    expect(handleMerchantText("cobrar", ctx())).toEqual({ kind: "usage" });
    const amb = handleMerchantText("cobrar 4,500 pizza", ctx());
    expect(amb).toMatchObject({ kind: "amount_error", error: "ambiguous" });
  });

  it("numbers references in order and answers status / cancel / close", () => {
    const paid: DemoInvoice = { ref: "A-0001", amount: "4500", desc: "", status: "paid" };
    const open: DemoInvoice = { ref: "A-0002", amount: "100", desc: "", status: "open" };
    expect(handleMerchantText("cobrar 100", ctx([paid])).kind === "charge" && (handleMerchantText("cobrar 100", ctx([paid])) as { invoice: DemoInvoice }).invoice.ref).toBe("A-0002");
    expect(handleMerchantText("¿me pagaron el A-0001?", ctx([paid, open]))).toMatchObject({ kind: "status", invoice: paid });
    expect(handleMerchantText("cancela el último cobro", ctx([paid, open]))).toMatchObject({ kind: "cancel", invoice: open });
    expect(handleMerchantText("/cierre", ctx([paid, open]))).toMatchObject({ kind: "close", paid: [paid], open: 1 });
    expect(handleMerchantText("hola qué tal", ctx()).kind).toBe("unknown");
  });

  it("quotes in USD₮ with bigint math, rounded up", () => {
    expect(toCents("4500.5")).toBe(450050n);
    const q = quoteMicro("4500", "AR"); // 4500 / 1650 × 1.001
    expect(q).toBe(2_730_000n);
    expect(formatUsdt(q, "es")).toBe("2,73");
    expect(formatUsdt(q, "en")).toBe("2.73");
    expect(quoteMicro("1000000", "AR") > DEMO_BALANCE_MICRO).toBe(true);
    expect(formatLocal("4500.5", "AR", "es")).toBe("$ 4.500,50");
    expect(formatLocal("30", "BR", "pt")).toBe("R$ 30");
  });

  it("every language has the same chips shape and fills every message", () => {
    for (const lang of ["es", "pt", "en"] as const) {
      const t = DEMO[lang];
      expect(t.chips.AR.length).toBe(4);
      expect(t.chips.BR.length).toBe(4);
      expect(t.invoice_caption("A-0001", "$ 1", "x")).toContain("A-0001");
      // the first chip of each country is a charge the engine understands
      expect(handleMerchantText(t.chips.AR[0]!, ctx([], lang)).kind).toBe("charge");
      expect(handleMerchantText(t.chips.BR[0]!, { country: "BR", lang, invoices: [] }).kind).toBe("charge");
    }
  });
});
