import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getAddress, isAddress, zeroAddress } from "viem";
import { english, portuguese, spanish } from "viem/accounts";
import { merchants, type Db } from "@cobra/db";
import {
  CELO,
  countryConfig,
  tokenByAddress,
  tokenBySymbol,
  type CountryCode,
  type Language,
  type TokenInfo,
} from "@cobra/shared";
import { TIMEZONE_BY_COUNTRY } from "./time";
import { isUsdtAddress, usdtToken } from "./usd";

export type MerchantRow = typeof merchants.$inferSelect;

export async function findMerchantByTelegramId(db: Db, telegramUserId: bigint | number): Promise<MerchantRow | null> {
  const [m] = await db.select().from(merchants).where(eq(merchants.telegramUserId, BigInt(telegramUserId)));
  return m ?? null;
}

export async function getMerchant(db: Db, id: string): Promise<MerchantRow | null> {
  const [m] = await db.select().from(merchants).where(eq(merchants.id, id));
  return m ?? null;
}

/** Settlement wFIAT for a country, or null if its token is not (yet) in the verified registry. */
export function settlementTokenFor(country: CountryCode): TokenInfo | null {
  const cfg = countryConfig(country);
  const token = tokenBySymbol(cfg.wfiatSymbol);
  if (!token || token.kind !== "wfiat" || token.currency !== cfg.currency || !token.verified) return null;
  return token;
}

const BIP39 = [english, spanish, portuguese].map((list) => new Set(list.map((w) => w.normalize("NFKD"))));
const SEED_LENGTHS = new Set([12, 15, 18, 21, 24]);

/**
 * Whole message is a private key (64 hex chars, with or without 0x) or a BIP-39 mnemonic (en/es/pt wordlists).
 * Note: a bare invoice id has the same shape as a private key; we err on the side of warning.
 */
export function looksLikeSecret(text: string): boolean {
  if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(text.trim())) return true;
  const words = text.toLowerCase().normalize("NFKD").split(/[\s,]+/).filter(Boolean);
  if (!SEED_LENGTHS.has(words.length)) return false;
  return BIP39.some((set) => words.every((w) => set.has(w)));
}

export type AddressCheck =
  | { ok: true; address: `0x${string}` }
  | { ok: false; error: "invalid" | "checksum" | "forbidden" | "secret" };

/**
 * Validates a pasted payout address. Never creates a wallet. Detects pasted private keys / seed phrases so the bot
 * can warn instead of echoing or storing them.
 */
export function checkPayoutAddress(input: string): AddressCheck {
  const s = input.trim();
  if (looksLikeSecret(s)) return { ok: false, error: "secret" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, error: "invalid" };
  if (!isAddress(s, { strict: true })) return { ok: false, error: "checksum" };
  const address = getAddress(s);
  const forbidden = [
    zeroAddress,
    CELO.permit2.address,
    CELO.uniswapV3.factory.address,
    CELO.uniswapV3.swapRouter.address,
    CELO.uniswapV3.quoterV2.address,
  ].map((a) => a.toLowerCase());
  if (forbidden.includes(address.toLowerCase()) || tokenByAddress(address)) return { ok: false, error: "forbidden" };
  return { ok: true, address };
}

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
}

const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function randomSlugSuffix(len = 5): string {
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join("");
}

export function makeStaticSlug(displayName: string | null | undefined): string {
  const base = slugify(displayName ?? "") || "comercio";
  return `${base}-${randomSlugSuffix()}`;
}

export async function createMerchant(
  db: Db,
  args: {
    telegramUserId: bigint | number;
    telegramChatId: bigint | number;
    displayName: string | null;
    country: CountryCode;
    payoutAddress: string;
    language: Language;
  },
): Promise<MerchantRow> {
  const token = settlementTokenFor(args.country);
  if (!token) throw new Error(`no settlement token for ${args.country}`);
  const cfg = countryConfig(args.country);
  for (let attempt = 0; ; attempt++) {
    try {
      const [m] = await db
        .insert(merchants)
        .values({
          telegramUserId: BigInt(args.telegramUserId),
          telegramChatId: BigInt(args.telegramChatId),
          displayName: args.displayName,
          country: args.country,
          currency: cfg.currency,
          settlementToken: token.address,
          payoutAddress: getAddress(args.payoutAddress),
          language: args.language,
          staticSlug: makeStaticSlug(args.displayName),
          timezone: TIMEZONE_BY_COUNTRY[args.country] ?? "America/Argentina/Buenos_Aires",
        })
        .returning();
      return m!;
    } catch (e) {
      // retry only on a static_slug collision (unique); a duplicate telegram user is a real error
      if (attempt >= 3 || !String((e as { cause?: unknown }).cause ?? e).includes("static_slug")) throw e;
    }
  }
}

export async function updateMerchant(
  db: Db,
  merchantId: string,
  patch: Partial<
    Pick<MerchantRow, "language" | "settlementToken" | "payoutAddress" | "payoutAddressProven" | "country" | "currency" | "timezone">
  >,
): Promise<MerchantRow | null> {
  const [m] = await db.update(merchants).set(patch).where(eq(merchants.id, merchantId)).returning();
  return m ?? null;
}

/**
 * The only two settlement choices of a merchant: the verified local wFIAT of its country, or the verified USD₮.
 * Anything else (another country's wFIAT, USDC, unknown symbols) is refused.
 */
export function settlementChoices(country: CountryCode): { local: TokenInfo | null; usd: TokenInfo | null } {
  return { local: settlementTokenFor(country), usd: usdtToken() };
}

/** Resolves a settlement choice by symbol ("wARS", "USDT", "USD₮", "USD"), case-insensitive. Null = not allowed. */
export function resolveSettlementChoice(country: CountryCode, input: string): TokenInfo | null {
  const s = input.trim().toUpperCase();
  const { local, usd } = settlementChoices(country);
  if (usd && (s === "USDT" || s === "USD₮" || s === "USD")) return usd;
  if (local && s === local.symbol.toUpperCase()) return local;
  return null;
}

/**
 * Country change: country, currency, timezone and the local wFIAT follow the new country; a merchant settled in
 * USD₮ stays in USD₮. The payout address is kept. Null if the new country has no verified wFIAT.
 */
export async function changeMerchantCountry(db: Db, merchant: MerchantRow, country: CountryCode): Promise<MerchantRow | null> {
  const local = settlementTokenFor(country);
  if (!local) return null;
  const keepUsd = isUsdtAddress(merchant.settlementToken) && usdtToken();
  return updateMerchant(db, merchant.id, {
    country,
    currency: countryConfig(country).currency,
    timezone: TIMEZONE_BY_COUNTRY[country] ?? merchant.timezone,
    settlementToken: keepUsd ? merchant.settlementToken : local.address,
  });
}
