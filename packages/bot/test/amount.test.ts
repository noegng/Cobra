import { describe, expect, it } from "vitest";
import { amountStyleFor, formatAmount, parseAmount, sumDecimals, type AmountError, type AmountStyle } from "../src/amount";

type Row = [input: string, style: AmountStyle, expected: string | AmountError];

const ERRORS = new Set<string>(["empty", "invalid", "ambiguous", "negative", "zero", "too_many_decimals", "too_large", "foreign_currency"]);

const TABLE: Row[] = [
  // --- spec examples ---
  ["4.500,50", "comma", "4500.5"],
  ["4500.5", "comma", "4500.5"],
  ["4500.5", "dot", "4500.5"],
  ["$4 500", "comma", "4500"],
  ["$4 500", "dot", "4500"],
  ["R$ 30,00", "comma", "30"],
  ["4,500.50", "dot", "4500.5"],
  ["4,500.50", "comma", "4500.5"], // both separators present: unambiguous
  ["4500", "comma", "4500"],
  ["4500", "dot", "4500"],
  ["1.000", "comma", "1000"],
  ["2 mil", "comma", "2000"],
  ["mil", "comma", "1000"],
  // --- plain integers / leading zeros ---
  ["0045", "comma", "45"],
  ["1", "comma", "1"],
  ["999999999999", "comma", "999999999999"],
  ["1000000000000", "comma", "too_large"],
  // --- comma locale (es-AR / pt-BR) ---
  ["4.500", "comma", "4500"],
  ["12.500", "comma", "12500"],
  ["120.000", "comma", "120000"],
  ["1.000.000", "comma", "1000000"],
  ["1.000.000,99", "comma", "1000000.99"],
  ["30,5", "comma", "30.5"],
  ["30,05", "comma", "30.05"],
  ["0,50", "comma", "0.5"],
  ["4500,50", "comma", "4500.5"],
  ["4,500", "comma", "ambiguous"],
  ["1,000,000", "comma", "1000000"], // repeated comma can only be grouping
  ["4.5000", "comma", "invalid"],
  ["4500.000", "comma", "ambiguous"],
  ["0.500", "comma", "ambiguous"],
  ["4,555", "comma", "ambiguous"],
  ["4,5555", "comma", "too_many_decimals"],
  ["1.00.000", "comma", "invalid"],
  ["1.000,5,5", "comma", "invalid"],
  ["1.000,505", "comma", "too_many_decimals"],
  ["10.00,50", "comma", "invalid"],
  // --- dot locale (en / es-MX) ---
  ["4,500", "dot", "4500"],
  ["1,000", "dot", "1000"],
  ["1,000,000.25", "dot", "1000000.25"],
  ["4.500", "dot", "ambiguous"],
  ["4.50", "dot", "4.5"],
  ["30,00", "dot", "30"], // 2 digits after comma is decimal in every locale
  ["4.5555", "dot", "too_many_decimals"],
  ["4,5555", "dot", "invalid"],
  // --- currency markers ---
  ["$ 4.500", "comma", "4500"],
  ["$4.500,00", "comma", "4500"],
  ["AR$ 1.500", "comma", "1500"],
  ["ARS 1500", "comma", "1500"],
  ["1500 ARS", "comma", "1500"],
  ["1500 pesos", "comma", "1500"],
  ["R$30", "comma", "30"],
  ["30 reais", "comma", "30"],
  ["BRL 30,90", "comma", "30.9"],
  ["S/ 25.50", "dot", "25.5"],
  ["4500$", "comma", "4500"],
  ["US$ 10", "comma", "foreign_currency"],
  ["10 usd", "dot", "foreign_currency"],
  ["10 dólares", "comma", "foreign_currency"],
  ["10 USDT", "comma", "foreign_currency"],
  // --- spaces / unicode spaces ---
  ["4 500", "comma", "4500"],
  ["4 500", "comma", "4500"],
  ["4 500,50", "comma", "4500.5"],
  ["1 000 000", "comma", "1000000"],
  ["  4500  ", "comma", "4500"],
  ["45 00", "comma", "invalid"],
  ["4 5", "comma", "invalid"],
  // --- mil ---
  ["1,5 mil", "comma", "1500"],
  ["1.5 mil", "dot", "1500"],
  ["2,25 mil", "comma", "2250"],
  ["10 mil", "comma", "10000"],
  ["2mil", "comma", "2000"],
  ["$ 2 mil", "comma", "2000"],
  ["2 mil pesos", "comma", "2000"],
  ["4,500 mil", "comma", "ambiguous"],
  // --- errors ---
  ["", "comma", "empty"],
  ["   ", "comma", "empty"],
  ["$", "comma", "empty"],
  ["abc", "comma", "invalid"],
  ["cuatro mil", "comma", "invalid"],
  ["4500abc", "comma", "invalid"],
  ["4.500,", "comma", "invalid"],
  [",50", "comma", "invalid"],
  ["-4500", "comma", "negative"],
  ["$-4500", "comma", "negative"],
  ["- $ 4500", "comma", "negative"],
  ["0", "comma", "zero"],
  ["0,00", "comma", "zero"],
  ["4,501", "comma", "ambiguous"],
  ["1e5", "comma", "invalid"],
  ["0x10", "comma", "invalid"],
  ["4500.5.5", "dot", "invalid"],
  ["4.5,5", "dot", "invalid"],
];

describe("parseAmount", () => {
  it.each(TABLE)("%j (%s) -> %s", (input, style, expected) => {
    const r = parseAmount(input, style);
    if (ERRORS.has(expected)) {
      expect(r).toEqual({ ok: false, error: expected });
    } else {
      expect(r).toEqual({ ok: true, value: expected });
    }
  });

  it("never returns more than 2 decimals or a non-canonical string", () => {
    for (const [input, style] of TABLE) {
      const r = parseAmount(input, style);
      if (r.ok) expect(r.value).toMatch(/^(0|[1-9]\d*)(\.\d{1,2})?$/);
    }
  });
});

describe("amountStyleFor / formatAmount / sumDecimals", () => {
  it("picks the separator convention per country", () => {
    expect(amountStyleFor("AR", "es")).toBe("comma");
    expect(amountStyleFor("BR", "en")).toBe("comma");
    expect(amountStyleFor("MX", "es")).toBe("dot");
    expect(amountStyleFor("PE", "es")).toBe("dot");
  });
  it("formats without floats", () => {
    expect(formatAmount("4500.5", "ARS", "comma")).toBe("$ 4.500,50");
    expect(formatAmount("30", "BRL", "comma")).toBe("R$ 30");
    expect(formatAmount("1234567.89", "MXN", "dot")).toBe("$ 1,234,567.89");
    expect(formatAmount("999", "PEN", "dot")).toBe("S/ 999");
  });
  it("sums decimal strings exactly", () => {
    expect(sumDecimals(["0.1", "0.2"])).toBe("0.3");
    expect(sumDecimals(["4500.5", "30", "0.05"])).toBe("4530.55");
    expect(sumDecimals([])).toBe("0");
  });
});
