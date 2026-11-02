import { getAddress, type Address } from "viem";
import { PullKind, type CountryCode, type Currency, type FiatCurrency } from "./types";

export interface TokenInfo {
  symbol: string;
  address: Address;
  decimals: number;
  currency: Currency;
  kind: "wfiat" | "usd";
  /** Supported pull mechanisms, in order of preference. ALLOWANCE always works as last resort. */
  pullKinds: PullKind[];
  /** EIP-712 domain used by the token itself (EIP-3009 / EIP-2612). null if unknown. */
  eip712: { name: string; version: string } | null;
  /** false = address/capabilities not yet checked on-chain. Never use unverified tokens on mainnet. */
  verified: boolean;
}

/**
 * Celo mainnet token registry. Capabilities below are PROVISIONAL until
 * docs/research/onchain-verification.md confirms them.
 */
export const TOKENS: readonly TokenInfo[] = [
  {
    symbol: "USDC",
    address: getAddress("0xcebA9300f2b948710d2653dD7B07f33A8B32118C"),
    decimals: 6,
    currency: "USD",
    kind: "usd",
    pullKinds: [PullKind.EIP3009, PullKind.PERMIT2, PullKind.ALLOWANCE],
    eip712: null,
    verified: false,
  },
  {
    symbol: "USDT",
    address: getAddress("0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"),
    decimals: 6,
    currency: "USD",
    kind: "usd",
    pullKinds: [PullKind.PERMIT2, PullKind.ALLOWANCE],
    eip712: null,
    verified: false,
  },
  {
    symbol: "wARS",
    address: getAddress("0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d"),
    decimals: 18,
    currency: "ARS",
    kind: "wfiat",
    pullKinds: [PullKind.PERMIT2, PullKind.ALLOWANCE],
    eip712: null,
    verified: false,
  },
  {
    symbol: "wBRL",
    address: getAddress("0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0"),
    decimals: 18,
    currency: "BRL",
    kind: "wfiat",
    pullKinds: [PullKind.PERMIT2, PullKind.ALLOWANCE],
    eip712: null,
    verified: false,
  },
];

export interface CountryConfig {
  country: CountryCode;
  currency: FiatCurrency;
  /** Settlement wFIAT symbol. May be absent from TOKENS until its address is verified. */
  wfiatSymbol: string;
  /** true = full conversion via Uniswap pools (v1: AR, BR). */
  conversion: boolean;
  defaultLanguage: "es" | "pt";
}

export const COUNTRIES: readonly CountryConfig[] = [
  { country: "AR", currency: "ARS", wfiatSymbol: "wARS", conversion: true, defaultLanguage: "es" },
  { country: "BR", currency: "BRL", wfiatSymbol: "wBRL", conversion: true, defaultLanguage: "pt" },
  { country: "MX", currency: "MXN", wfiatSymbol: "wMXN", conversion: false, defaultLanguage: "es" },
  { country: "CO", currency: "COP", wfiatSymbol: "wCOP", conversion: false, defaultLanguage: "es" },
  { country: "CL", currency: "CLP", wfiatSymbol: "wCLP", conversion: false, defaultLanguage: "es" },
  { country: "PE", currency: "PEN", wfiatSymbol: "wPEN", conversion: false, defaultLanguage: "es" },
];

export function tokenBySymbol(symbol: string): TokenInfo | undefined {
  return TOKENS.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase());
}

export function tokenByAddress(address: string): TokenInfo | undefined {
  const a = address.toLowerCase();
  return TOKENS.find((t) => t.address.toLowerCase() === a);
}

export function countryConfig(country: CountryCode): CountryConfig {
  const c = COUNTRIES.find((x) => x.country === country);
  if (!c) throw new Error(`unknown country ${country}`);
  return c;
}

/** Decimal string ("4500.50") -> base units, exact (no float). Throws on too many decimals. */
export function toBaseUnits(decimal: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(decimal)) throw new Error(`invalid decimal string: ${decimal}`);
  const [int, frac = ""] = decimal.split(".") as [string, string?];
  if (frac.length > decimals) throw new Error(`too many decimals (${frac.length} > ${decimals})`);
  return BigInt(int) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Base units -> decimal string without trailing zeros ("4500.5"). */
export function fromBaseUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}
