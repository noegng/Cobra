/**
 * Strict local-amount parser for the static QR (payer types the amount). Deterministic, no floats.
 * Accepts "4500", "4500.5", "4500,50" (comma = decimal separator, LatAm style).
 * Rejects thousands separators ("4.500,00", "4,500.00"), signs, exponents, spaces inside, > 2 decimals, zero.
 */
export const MAX_LOCAL_INTEGER_DIGITS = 12;

export type ParsedAmount = { ok: true; value: string } | { ok: false; reason: "empty" | "format" | "zero" | "too_large" };

export function parseLocalAmount(input: unknown): ParsedAmount {
  if (typeof input !== "string") return { ok: false, reason: "format" };
  const s = input.trim();
  if (s === "") return { ok: false, reason: "empty" };
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return { ok: false, reason: "format" };
  const int = m[1]!.replace(/^0+(?=\d)/, "");
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (int.length > MAX_LOCAL_INTEGER_DIGITS) return { ok: false, reason: "too_large" };
  if (/^0*$/.test(int) && frac === "") return { ok: false, reason: "zero" };
  return { ok: true, value: frac ? `${int}.${frac}` : int };
}

/** Formats a base-unit integer for display with locale grouping, without floats. */
export function formatUnits(amount: bigint | string, decimals: number, locale: string, maxFraction = 2): string {
  const v = typeof amount === "string" ? BigInt(amount) : amount;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  // round half up to `keep` fraction digits, entirely in bigint
  const keep = Math.min(maxFraction, decimals);
  const scale = 10n ** BigInt(decimals - keep);
  const rounded = scale > 1n ? (abs + scale / 2n) / scale : abs; // value in units of 10^-keep
  const unit = 10n ** BigInt(keep);
  const int = rounded / unit;
  const frac = rounded % unit;
  const grouped = int.toLocaleString(locale);
  const decSep = (1.5).toLocaleString(locale).charAt(1) || ".";
  const fracStr = keep > 0 ? frac.toString().padStart(keep, "0") : "";
  return `${neg ? "-" : ""}${grouped}${fracStr ? decSep + fracStr : ""}`;
}

/** Formats a decimal string ("4500.5") for display with locale grouping. */
export function formatDecimal(value: string, locale: string, fractionDigits = 2): string {
  const [i = "0", f = ""] = value.split(".");
  const padded = (f + "0".repeat(fractionDigits)).slice(0, fractionDigits);
  const units = BigInt(i + padded);
  return formatUnits(units, fractionDigits, locale, fractionDigits);
}
