import { describe, expect, it } from "vitest";
import { matchCharge } from "../src/fastpath";

describe("matchCharge (fast path regex)", () => {
  it.each([
    ["cobrar 4500 café", "4500", "café"],
    ["Cobrar 4.500,50 corte de pelo", "4.500,50", "corte de pelo"],
    ["/cobrar 4500 café", "4500", "café"],
    ["/cobrar@cobra_test_bot 4500 café", "4500", "café"],
    ["cobrá $ 4 500 empanadas", "$ 4 500", "empanadas"],
    ["cobrar R$ 30,00 corte", "R$ 30,00", "corte"],
    ["cobrar 2 mil pizza", "2 mil", "pizza"],
    ["cobrar 2 milanesas", "2", "milanesas"],
    ["cobrar 4500 2 cafés", "4500", "2 cafés"],
    ["cobrar 4500, café y medialunas", "4500", "café y medialunas"],
    ["cobrar 1500 pesos alfajor", "1500 pesos", "alfajor"],
    ["charge 4,500.50 coffee", "4,500.50", "coffee"],
    ["cobrar 4500", "4500", ""],
    ["cobrar   4500   ", "4500", ""],
    ["cobrar US$ 10 algo", "US$ 10", "algo"], // parser then rejects the foreign currency
  ])("%j", (text, amount, description) => {
    expect(matchCharge(text)).toEqual({ amountText: amount, description });
  });

  it.each([
    ["cobrar 4 500 café", "4 500", "café"],
    ["cobrar 500 100 gramos de queso", "500 100", "gramos de queso"],
    ["cobrar 1\u00a0500 alfajor", "1\u00a0500", "alfajor"],
  ])("flags an unmarked space-grouped amount followed by text as ambiguous: %j", (text, amount, description) => {
    expect(matchCharge(text)).toEqual({ amountText: amount, description, spaceAmbiguous: true });
  });

  it.each([
    ["cobrar 4 500", "4 500", ""], // nothing after: the grouping is the only reading
    ["cobrar R$ 1 500 corte", "R$ 1 500", "corte"],
    ["cobrar 4 500 pesos café", "4 500 pesos", "café"],
    ["cobrar 4 cafés", "4", "cafés"],
  ])("keeps unambiguous forms: %j", (text, amount, description) => {
    expect(matchCharge(text)).toEqual({ amountText: amount, description });
  });

  it("returns an empty amount for a bare trigger (usage reply)", () => {
    expect(matchCharge("cobrar")).toEqual({ amountText: "", description: "" });
    expect(matchCharge("/cobrar")).toEqual({ amountText: "", description: "" });
  });

  it.each(["hola", "cobrame lo de ayer", "cobrar el café de ayer", "quiero cobrar 4500", "¿me pagaron?", "cobrarle 300"])(
    "does not match %j (goes to the LLM)",
    (text) => {
      expect(matchCharge(text)).toBeNull();
    },
  );
});
