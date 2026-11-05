import { describe, expect, it } from "vitest";
import { costLabel, effectiveRate } from "../lib/units";

describe("effectiveRate", () => {
  it("shows local currency per dollar for dollar legs (mainnet payment #3: 100 ARS for 0.060274 USD₮)", () => {
    expect(effectiveRate("100", "ARS", [{ symbol: "USD₮", amountIn: "60274", decimals: 6 }], "en-US")).toBe("1 USD ≈ 1,659.09 ARS");
    expect(effectiveRate("100", "ARS", [{ symbol: "USD₮", amountIn: "60274", decimals: 6 }], "es-AR")).toBe("1 USD ≈ 1.659,09 ARS");
  });
  it("sums legs with different decimals", () => {
    const legs = [
      { symbol: "USDC", amountIn: "1000000", decimals: 6 },
      { symbol: "USDm", amountIn: "1000000000000000000", decimals: 18 },
    ];
    expect(effectiveRate("10.88", "BRL", legs, "en-US")).toBe("1 USD ≈ 5.44 BRL");
  });
  it("returns null for wFIAT legs or a zero total", () => {
    expect(effectiveRate("1000", "ARS", [{ symbol: "wARS", amountIn: "1000000000000000000000", decimals: 18 }], "en-US")).toBeNull();
    expect(effectiveRate("1", "ARS", [{ symbol: "USDC", amountIn: "0", decimals: 6 }], "en-US")).toBeNull();
    expect(effectiveRate("1", "ARS", [], "en-US")).toBeNull();
  });
});

describe("costLabel", () => {
  it("formats bps as a percentage and clamps negatives to 0", () => {
    expect(costLabel(68, "en-US")).toBe("0.68 %");
    expect(costLabel(68, "pt-BR")).toBe("0,68 %");
    expect(costLabel(-3, "en-US")).toBe("0 %");
  });
});
