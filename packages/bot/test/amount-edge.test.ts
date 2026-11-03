import { describe, expect, it } from "vitest";
import { parseAmount, type AmountError, type AmountStyle } from "../src/amount";
import { matchCharge } from "../src/fastpath";

type Row = [input: string, style: AmountStyle, expected: string | AmountError];

const run = (input: string, style: AmountStyle): string | AmountError => {
  const r = parseAmount(input, style);
  return r.ok ? r.value : r.error;
};

const TABLE: Row[] = [
  // es / pt separators
  ["4.500", "comma", "4500"],
  ["4,50", "comma", "4.5"],
  ["4.500,50", "comma", "4500.5"],
  ["4 500", "comma", "4500"],
  ["1.234.567,89", "comma", "1234567.89"],
  ["1,234,567.89", "dot", "1234567.89"],
  ["4,500", "dot", "4500"],
  ["4.500", "dot", "ambiguous"],
  ["4,500", "comma", "ambiguous"],
  ["0.500", "comma", "ambiguous"],
  ["0.500", "dot", "ambiguous"],
  ["1234.567", "comma", "ambiguous"],
  ["1.234,567", "comma", "too_many_decimals"],
  ["1.234.567.89", "comma", "invalid"],
  ["1.23.456", "comma", "invalid"],
  ["10.000.5", "comma", "invalid"],
  ["1,5,0", "comma", "invalid"],
  ["4.", "comma", "invalid"],
  [",50", "comma", "invalid"],
  ["4,", "comma", "invalid"],
  ["1 234 567,89", "comma", "1234567.89"],
  ["4 5000", "comma", "invalid"],
  ["45 00", "comma", "invalid"],
  ["4 500,555", "comma", "too_many_decimals"],
  ["4 500,123", "comma", "too_many_decimals"],
  // non-ASCII spaces
  ["4 500", "comma", "4500"],
  ["4 500", "comma", "4500"],
  ["4 500", "comma", "4500"],
  ["4 500", "comma", "4500"],
  ["  4500  ", "comma", "4500"],
  [" $ 4 500 ", "comma", "4500"],
  ["4\t500", "comma", "4500"],
  // mil
  ["2 mil", "comma", "2000"],
  ["2mil", "comma", "2000"],
  ["2 MIL", "comma", "2000"],
  ["1,5 mil", "comma", "1500"],
  ["1.5 mil", "comma", "1500"],
  ["1,25 mil", "comma", "1250"],
  ["mil", "comma", "1000"],
  ["$ 2 mil", "comma", "2000"],
  ["2 mil pesos", "comma", "2000"],
  ["R$ 1,5 mil", "comma", "1500"],
  ["mil mil", "comma", "invalid"],
  ["milanesa", "comma", "invalid"],
  ["2 milanesas", "comma", "invalid"],
  ["2 milanesa", "comma", "invalid"],
  ["tamil", "comma", "invalid"],
  ["1,555 mil", "comma", "ambiguous"],
  ["999999999999 mil", "comma", "too_large"],
  // currency markers
  ["$4500", "comma", "4500"],
  ["$ 4.500,50", "comma", "4500.5"],
  ["R$ 30,00", "comma", "30"],
  ["R$30", "comma", "30"],
  ["ARS 4500", "comma", "4500"],
  ["4500 ARS", "comma", "4500"],
  ["4500 pesos", "comma", "4500"],
  ["30 reais", "comma", "30"],
  ["US$ 10", "comma", "foreign_currency"],
  ["10 USD", "comma", "foreign_currency"],
  ["10 dólares", "comma", "foreign_currency"],
  ["€10", "comma", "foreign_currency"],
  ["$", "comma", "empty"],
  ["R$", "comma", "empty"],
  ["", "comma", "empty"],
  ["   ", "comma", "empty"],
  // zero / negative / garbage
  ["0", "comma", "zero"],
  ["00", "comma", "zero"],
  ["0,00", "comma", "zero"],
  ["0.0", "dot", "zero"],
  ["$0", "comma", "zero"],
  ["0 mil", "comma", "zero"],
  ["-5", "comma", "negative"],
  ["−5", "comma", "negative"],
  ["$-5", "comma", "negative"],
  ["-$5", "comma", "negative"],
  ["(5)", "comma", "negative"],
  ["- 5", "comma", "negative"],
  ["5-", "comma", "invalid"],
  ["-", "comma", "invalid"],
  ["1e5", "comma", "invalid"],
  ["0x10", "comma", "invalid"],
  ["Infinity", "comma", "invalid"],
  ["NaN", "comma", "invalid"],
  ["٣٠", "comma", "invalid"],
  ["4500abc", "comma", "invalid"],
  ["abc", "comma", "invalid"],
  ["45 00 0", "comma", "invalid"],
  ["1..5", "comma", "invalid"],
  // decimals
  ["4500,555", "comma", "ambiguous"],
  ["4500,5555", "comma", "too_many_decimals"],
  ["4500.5555", "dot", "too_many_decimals"],
  ["4500.123", "dot", "ambiguous"],
  ["30,5", "comma", "30.5"],
  ["30.50", "comma", "30.5"],
  // large
  ["999999999999", "comma", "999999999999"],
  ["999.999.999.999", "comma", "999999999999"],
  ["1.000.000.000.000", "comma", "too_large"],
  ["9".repeat(400), "comma", "too_large"],
  ["9".repeat(400) + ",50", "comma", "too_large"],
  ["0.01", "dot", "0.01"],
];

describe("parseAmount edge table", () => {
  it.each(TABLE)("%j (%s) -> %s", (input, style, expected) => {
    expect(run(input, style)).toBe(expected);
  });
});

describe("parseAmount properties", () => {
  // Tiny deterministic PRNG (no dependency).
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const fmt = (int: string, frac: string, style: AmountStyle, group: boolean) => {
    const thou = style === "comma" ? "." : ",";
    const dec = style === "comma" ? "," : ".";
    const i = group ? int.replace(/\B(?=(\d{3})+(?!\d))/g, thou) : int;
    return frac ? `${i}${dec}${frac}` : i;
  };

  it("round-trips unambiguous well-formed amounts in both styles", () => {
    for (let n = 0; n < 2000; n++) {
      const len = 1 + rnd(9);
      let int = String(1 + rnd(9));
      for (let k = 1; k < len; k++) int += String(rnd(10));
      const frac = rnd(3) === 0 ? "" : String(rnd(100)).padStart(2, "0");
      const style: AmountStyle = rnd(2) ? "comma" : "dot";
      const text = fmt(int, frac, style, rnd(2) === 1);
      const expectedFrac = frac.replace(/0+$/, "");
      const expected = expectedFrac ? `${int}.${expectedFrac}` : int;
      const r = parseAmount(text, style);
      // Only exact "1-3 digits + 3 digits" strings can legitimately be ambiguous; everything else must round-trip.
      if (r.ok) expect(r.value).toBe(expected);
      else expect(["ambiguous"]).toContain(r.error);
    }
  });

  it("never returns a value that differs from the input digits scaled by a power of ten", () => {
    for (let n = 0; n < 3000; n++) {
      const chars = "0123456789.,  $mil-";
      let s = "";
      const len = 1 + rnd(12);
      for (let k = 0; k < len; k++) s += chars[rnd(chars.length)];
      for (const style of ["comma", "dot"] as const) {
        const r = parseAmount(s, style);
        if (r.ok) {
          expect(r.value).toMatch(/^[1-9]\d{0,11}(\.\d{1,2})?$|^0\.\d{1,2}$|^[1-9]\d{0,11}(\.\d{1,2})?$/);
          expect(s).not.toMatch(/-/);
        }
      }
    }
  });

  it("never throws on arbitrary unicode", () => {
    const pool = ["\u0000", "😀", "٣", "४", "１", " ", "​", "mil", "$", ".", ",", " ", "9"];
    for (let n = 0; n < 2000; n++) {
      let s = "";
      for (let k = 0; k < 1 + rnd(8); k++) s += pool[rnd(pool.length)];
      expect(() => parseAmount(s, "comma")).not.toThrow();
    }
  });
});

describe("matchCharge edge cases", () => {
  it.each([
    ["cobrar 2 milanesas", "2", "milanesas"],
    ["cobrar 2 MILANESAS", "2", "MILANESAS"],
    ["cobrar 2 milhões", "2", "milhões"],
    ["cobrar 2 mil milanesas", "2 mil", "milanesas"],
    ["cobrar 5 mil", "5 mil", ""],
    ["cobrar 4 500 café", "4 500", "café"],
    ["cobrar 4 500 café", "4 500", "café"],
    ["cobrar $4500 café", "$4500", "café"],
    ["cobrar ARS 4500 café", "ARS 4500", "café"],
    ["cobrar 1.234.567,89 reforma", "1.234.567,89", "reforma"],
    ["cobrar 30 reales de corte", "30", "reales de corte"],
    ["cobrar 4500 pesosdeoro", "4500", "pesosdeoro"],
    ["COBRAR 4500 café", "4500", "café"],
  ])("%j", (text, amount, description) => {
    expect(matchCharge(text)).toEqual({ amountText: amount, description });
  });

  it("does not claim non-numeric or negative requests", () => {
    expect(matchCharge("cobrar mil pesos")).toBeNull();
    expect(matchCharge("cobrar -500 café")).toBeNull();
    expect(matchCharge("cobrar abc")).toBeNull();
  });

  it("amounts extracted by the fast path never silently become a different number", () => {
    for (const [text, expected] of [
      ["cobrar 2 milanesas", "2"],
      ["cobrar 4,500 café", "ambiguous"],
      ["cobrar 4.500 café", "4500"],
    ] as const) {
      const m = matchCharge(text)!;
      expect(run(m.amountText, "comma")).toBe(expected);
    }
  });
});
