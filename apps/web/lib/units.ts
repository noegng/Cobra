/**
 * Plain-language units, so a payer always knows what currency each number is in:
 * "4.500 ARS · pesos argentinos", "2,73 USD₮ · dólares digitales", "4.500 wARS · peso digital (1 = 1 ARS)".
 */
import type { Language } from "@cobra/shared";

const FIAT: Record<string, Record<Language, string>> = {
  ARS: { es: "pesos argentinos", pt: "pesos argentinos", en: "Argentine pesos" },
  BRL: { es: "reales", pt: "reais", en: "Brazilian reais" },
  MXN: { es: "pesos mexicanos", pt: "pesos mexicanos", en: "Mexican pesos" },
  COP: { es: "pesos colombianos", pt: "pesos colombianos", en: "Colombian pesos" },
  CLP: { es: "pesos chilenos", pt: "pesos chilenos", en: "Chilean pesos" },
  PEN: { es: "soles", pt: "soles", en: "Peruvian soles" },
};

const DOLLARS: Record<Language, string> = { es: "dólares digitales", pt: "dólares digitais", en: "digital dollars" };
const DOLLAR_SYMBOLS = new Set(["USD₮", "USDT", "USDC", "USAT", "USA₮", "USDm", "cUSD"]);

/** "pesos argentinos" for ARS; the code itself when unknown. */
export function fiatName(currency: string, lang: Language): string {
  return FIAT[currency]?.[lang] ?? currency;
}

/** Plain name of a token: dollars for USD stablecoins, "peso digital (1 = 1 ARS)" for wFIAT. */
export function tokenName(symbol: string, lang: Language): string {
  if (DOLLAR_SYMBOLS.has(symbol)) return DOLLARS[lang];
  const m = /^w([A-Z]{3})$/.exec(symbol);
  if (m) {
    const ccy = m[1]!;
    const name = FIAT[ccy]?.[lang] ?? ccy;
    if (lang === "en") return `digital ${name} (1 = 1 ${ccy})`;
    return `${name} ${lang === "pt" ? "digitais" : "digitales"} (1 = 1 ${ccy})`;
  }
  return symbol;
}

/** One kind label for a set of legs: all dollars → "dólares digitales", otherwise the token names joined. */
export function legsName(symbols: readonly string[], lang: Language): string {
  const names = [...new Set(symbols.map((s) => tokenName(s, lang)))];
  return names.join(" + ");
}

type ReceiptLabels = {
  invoice: string;
  merchant_gets: string;
  you_pay: string;
  you_pay_hint: string;
  rate: string;
  cost: string;
  network_fee: string;
  network_fee_free: string;
};

export const RECEIPT: Record<Language, ReceiptLabels> = {
  es: {
    invoice: "Cobro",
    merchant_gets: "El comercio recibe",
    you_pay: "Tú pagas",
    you_pay_hint: "Se calcula al conectar tu billetera",
    rate: "Tipo de cambio",
    cost: "Costo vs. tipo de referencia",
    network_fee: "Comisión de red",
    network_fee_free: "Gratis, la paga Cobrá",
  },
  pt: {
    invoice: "Cobrança",
    merchant_gets: "O comércio recebe",
    you_pay: "Você paga",
    you_pay_hint: "Calculado ao conectar sua carteira",
    rate: "Câmbio",
    cost: "Custo vs. câmbio de referência",
    network_fee: "Taxa de rede",
    network_fee_free: "Grátis, paga pela Cobrá",
  },
  en: {
    invoice: "Invoice",
    merchant_gets: "Merchant receives",
    you_pay: "You pay",
    you_pay_hint: "Calculated when you connect your wallet",
    rate: "Exchange rate",
    cost: "Cost vs. reference rate",
    network_fee: "Network fee",
    network_fee_free: "Free, paid by Cobrá",
  },
};

/**
 * Effective rate the payer gets, "1 USD ≈ 1.659,12 ARS", when every leg is a dollar stablecoin. Display only:
 * bigint math, rounded half up to 2 decimals. null for wFIAT legs (no conversion to show) or a zero total.
 */
export function effectiveRate(
  amountLocal: string,
  currency: string,
  legs: readonly { symbol: string; amountIn: string; decimals: number }[],
  locale: string,
): string | null {
  if (legs.length === 0 || !legs.every((l) => DOLLAR_SYMBOLS.has(l.symbol))) return null;
  const [i = "0", f = ""] = amountLocal.split(".");
  const local18 = BigInt(i + (f + "0".repeat(18)).slice(0, 18));
  const dollars18 = legs.reduce((sum, l) => sum + BigInt(l.amountIn) * 10n ** BigInt(18 - l.decimals), 0n);
  if (dollars18 <= 0n) return null;
  const cents = (local18 * 100n * 2n + dollars18) / (dollars18 * 2n);
  const two = (1.5).toLocaleString(locale).charAt(1) || ".";
  const int = (cents / 100n).toLocaleString(locale);
  return `1 USD ≈ ${int}${two}${String(cents % 100n).padStart(2, "0")} ${currency}`;
}

/** "0,68 %": total conversion cost against the reference rate. Negative (better than reference) shows as 0 %. */
export function costLabel(costBps: number, locale: string): string {
  const pct = Math.max(0, costBps) / 100;
  return `${pct.toLocaleString(locale, { maximumFractionDigits: 2 })} %`;
}

/** Label of the on-ramp button, in the page language: "Pagar en reales", "Pagar em pesos argentinos", "Pay in Brazilian reais". */
export function payInFiatLabel(currency: string, lang: Language): string {
  const name = fiatName(currency, lang);
  return lang === "en" ? `Pay in ${name}` : lang === "pt" ? `Pagar em ${name}` : `Pagar en ${name}`;
}
