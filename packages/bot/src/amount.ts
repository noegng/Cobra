/**
 * Deterministic, locale-aware amount parser. The LLM never computes amounts: it passes the raw text the merchant
 * typed, and this module turns it into a canonical decimal string ("4500.5") or a typed error.
 *
 * `style` is the merchant's decimal separator convention:
 *   - "comma": es-AR, pt-BR, es-CO, es-CL  -> "4.500,50"
 *   - "dot":   en, es-MX, es-PE             -> "4,500.50"
 *
 * Rules (in order):
 *   - currency markers ($, R$, AR$, S/, ARS, BRL, pesos, reais...) are ignored; foreign USD markers are rejected.
 *   - "mil" multiplies by 1000 ("2 mil", "1,5 mil", "mil").
 *   - spaces may group thousands only in exact groups of 3 ("$4 500").
 *   - both "." and "," present: the LAST one is the decimal separator, the other one groups thousands (strictly by 3).
 *   - one separator repeated ("1.000.000", "1,000,000"): thousands grouping, strictly by 3.
 *   - one separator once:
 *       1-2 digits after  -> decimal ("4500.5", "30,00") — unambiguous in every locale for fiat;
 *       exactly 3 after   -> thousands if it is the locale's thousands separator ("1.000" in es/pt = 1000),
 *                            otherwise AMBIGUOUS ("4,500" in es/pt, "4.500" in en);
 *       more than 3 after -> too_many_decimals / invalid.
 *   - at most 2 decimals (fiat), at most 12 integer digits, strictly positive.
 */
export type AmountStyle = "comma" | "dot";

export type AmountError =
  | "empty"
  | "invalid"
  | "ambiguous"
  | "negative"
  | "zero"
  | "too_many_decimals"
  | "too_large"
  | "foreign_currency";

export type AmountResult = { ok: true; value: string } | { ok: false; error: AmountError };

export const MAX_INTEGER_DIGITS = 12;
export const MAX_FIAT_DECIMALS = 2;

const FOREIGN = /(?:us\$|u\$s|usd|usdt|usdc|dólares?|dolares?|dollars?|€|eur)/;
const PREFIX = /^(?:r\$|ar\$|mx\$|col\$|clp\$|s\/\.?|\$|ars|brl|mxn|cop|clp|pen)\s*/;
const SUFFIX = /\s*(?:pesos?|reais|real|soles?|ars|brl|mxn|cop|clp|pen|\$)$/;

const err = (error: AmountError): AmountResult => ({ ok: false, error });

function normalizeSpaces(s: string): string {
  // NBSP, narrow NBSP, thin space, figure space -> plain space
  return s.replace(/[    ]/g, " ").replace(/\s+/g, " ").trim();
}

function grouped(s: string, sep: string): boolean {
  const e = sep === "." ? "\\." : sep;
  return new RegExp(`^\\d{1,3}(?:${e}\\d{3})+$`).test(s);
}

/** Splits a separator-only numeric string into [int, frac]. */
function splitNumber(n: string, style: AmountStyle): { int: string; frac: string } | AmountError {
  const localeThousands = style === "comma" ? "." : ",";
  const dots = (n.match(/\./g) ?? []).length;
  const commas = (n.match(/,/g) ?? []).length;

  if (dots === 0 && commas === 0) return { int: n, frac: "" };

  if (dots > 0 && commas > 0) {
    const decSep = n.lastIndexOf(".") > n.lastIndexOf(",") ? "." : ",";
    const thouSep = decSep === "." ? "," : ".";
    const idx = n.lastIndexOf(decSep);
    const intPart = n.slice(0, idx);
    const frac = n.slice(idx + 1);
    if (intPart.includes(decSep)) return "invalid"; // decimal separator twice
    if (!grouped(intPart, thouSep)) return "invalid";
    if (frac.length === 0) return "invalid";
    if (frac.length > MAX_FIAT_DECIMALS) return "too_many_decimals";
    return { int: intPart.split(thouSep).join(""), frac };
  }

  const sep = dots > 0 ? "." : ",";
  const count = dots + commas;
  if (count > 1) {
    if (!grouped(n, sep)) return "invalid";
    if (n.startsWith("0")) return "ambiguous";
    return { int: n.split(sep).join(""), frac: "" };
  }

  const idx = n.indexOf(sep);
  const before = n.slice(0, idx);
  const after = n.slice(idx + 1);
  if (before.length === 0 || after.length === 0) return "invalid";
  if (after.length <= MAX_FIAT_DECIMALS) return { int: before, frac: after };
  if (after.length === 3) {
    if (sep === localeThousands && before.length <= 3 && !before.startsWith("0")) return { int: before + after, frac: "" };
    return "ambiguous";
  }
  return sep === localeThousands ? "invalid" : "too_many_decimals";
}

export function parseAmount(input: string, style: AmountStyle): AmountResult {
  let s = normalizeSpaces(input.normalize("NFKC").toLowerCase());
  if (s === "") return err("empty");
  if (FOREIGN.test(s)) return err("foreign_currency");
  if (/^[-−(]|[-−]\s*\$?\s*\d/.test(s)) return /\d/.test(s) ? err("negative") : err("invalid");

  s = s.replace(PREFIX, "").replace(SUFFIX, "").trim();
  // a second marker after "mil" ("2 mil pesos") or before the number ("$ R$") is handled by one more pass
  s = s.replace(PREFIX, "").replace(SUFFIX, "").trim();

  let thousandMultiplier = false;
  const mil = /^(.*?)\s*mil$/.exec(s);
  if (mil) {
    thousandMultiplier = true;
    s = mil[1]!.trim() || "1";
  }
  if (s === "") return err("empty");

  if (s.includes(" ")) {
    // Space-grouped thousands, optionally followed by a decimal part: "4 500", "4 500,50", "1 000 000.5"
    const m = /^(\d{1,3}(?: \d{3})+)([.,]\d+)?$/.exec(s);
    if (!m) return err("invalid");
    s = m[1]!.replace(/ /g, "") + (m[2] ?? "");
    if (m[2] && m[2].length - 1 > MAX_FIAT_DECIMALS) return err("too_many_decimals");
    if (m[2] && m[2].length - 1 === 3) return err("ambiguous");
  }

  if (!/^\d(?:[\d.,]*\d)?$/.test(s)) return err("invalid");

  const parts = splitNumber(s, style);
  if (typeof parts === "string") return err(parts);

  let int = parts.int.replace(/^0+(?=\d)/, "");
  let frac = parts.frac;
  if (thousandMultiplier) {
    const padded = frac.padEnd(3, "0");
    int = (int + padded.slice(0, 3)).replace(/^0+(?=\d)/, "");
    frac = padded.slice(3);
  }
  frac = frac.replace(/0+$/, "");

  if (/^0*$/.test(int) && frac === "") return err("zero");
  if (int.length > MAX_INTEGER_DIGITS) return err("too_large");
  return { ok: true, value: frac ? `${int}.${frac}` : int };
}

/** Decimal convention per country (how merchants type and read numbers). */
export function amountStyleFor(country: string, language: string): AmountStyle {
  if (country === "MX" || country === "PE") return "dot";
  if (country === "AR" || country === "BR" || country === "CO" || country === "CL") return "comma";
  return language === "en" ? "dot" : "comma";
}

const CURRENCY_SYMBOL: Record<string, string> = {
  ARS: "$",
  BRL: "R$",
  MXN: "$",
  COP: "$",
  CLP: "$",
  PEN: "S/",
  USD: "US$",
};

/**
 * Currency written out, so "$ 4.500" never reads as dollars: "$" is also the peso sign in AR, MX, CO and CL.
 * Plain words a merchant uses every day; the ISO code stays the fallback.
 */
const CURRENCY_NAME: Record<string, Record<"es" | "pt" | "en", string>> = {
  ARS: { es: "pesos argentinos", pt: "pesos argentinos", en: "Argentine pesos" },
  BRL: { es: "reales", pt: "reais", en: "Brazilian reais" },
  MXN: { es: "pesos mexicanos", pt: "pesos mexicanos", en: "Mexican pesos" },
  COP: { es: "pesos colombianos", pt: "pesos colombianos", en: "Colombian pesos" },
  CLP: { es: "pesos chilenos", pt: "pesos chilenos", en: "Chilean pesos" },
  PEN: { es: "soles", pt: "soles", en: "Peruvian soles" },
  USD: { es: "dólares", pt: "dólares", en: "US dollars" },
};

export function currencyName(currency: string, lang: string): string {
  const l = lang === "pt" || lang === "en" ? lang : "es";
  return CURRENCY_NAME[currency]?.[l] ?? currency;
}

/** "4500.5" -> "$ 4.500,50 pesos argentinos": the amount as the merchant and the payer read it everywhere. */
export function formatAmountNamed(value: string, currency: string, style: AmountStyle, lang: string): string {
  return `${formatAmount(value, currency, style)} ${currencyName(currency, lang)}`;
}

/** Deterministic display formatting of a decimal string (no floats): "4500.5" -> "$ 4.500,50". */
export function formatAmount(value: string, currency: string, style: AmountStyle): string {
  const [intRaw = "0", fracRaw = ""] = value.split(".");
  const thou = style === "comma" ? "." : ",";
  const dec = style === "comma" ? "," : ".";
  const int = intRaw.replace(/\B(?=(\d{3})+(?!\d))/g, thou);
  const frac = fracRaw ? dec + fracRaw.padEnd(2, "0") : "";
  const symbol = CURRENCY_SYMBOL[currency] ?? currency;
  return `${symbol} ${int}${frac}`;
}

/** Exact sum of decimal strings (bigint, 18 decimals of headroom). */
export function sumDecimals(values: readonly string[]): string {
  const scale = 18;
  let total = 0n;
  for (const v of values) {
    const [i = "0", f = ""] = v.split(".");
    total += BigInt(i) * 10n ** BigInt(scale) + BigInt((f.slice(0, scale) || "0").padEnd(scale, "0"));
  }
  const base = 10n ** BigInt(scale);
  const frac = (total % base).toString().padStart(scale, "0").replace(/0+$/, "");
  return `${total / base}${frac ? `.${frac}` : ""}`;
}
