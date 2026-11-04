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

export const RECEIPT: Record<Language, { invoice: string; merchant_gets: string; you_pay: string; you_pay_hint: string }> = {
  es: { invoice: "Cobro", merchant_gets: "El comercio recibe", you_pay: "Tú pagas", you_pay_hint: "Se calcula al conectar tu billetera" },
  pt: { invoice: "Cobrança", merchant_gets: "O comércio recebe", you_pay: "Você paga", you_pay_hint: "Calculado ao conectar sua carteira" },
  en: { invoice: "Invoice", merchant_gets: "Merchant receives", you_pay: "You pay", you_pay_hint: "Calculated when you connect your wallet" },
};

/** Label of the on-ramp button, in the page language: "Pagar en reales", "Pagar em pesos argentinos", "Pay in Brazilian reais". */
export function payInFiatLabel(currency: string, lang: Language): string {
  const name = fiatName(currency, lang);
  return lang === "en" ? `Pay in ${name}` : lang === "pt" ? `Pagar em ${name}` : `Pagar en ${name}`;
}
