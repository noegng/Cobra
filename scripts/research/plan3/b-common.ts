import type { Address } from "viem";
export const FACTORY: Address = "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc";
export const QUOTER: Address = "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8";
export const FEES = [100, 500, 3000, 10000] as const;
export const TOKENS: Record<string, { address: Address; decimals: number; stable: boolean }> = {
  USDC: { address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6, stable: true },
  USDT: { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6, stable: true },
  USAT: { address: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", decimals: 6, stable: true },
  wARS: { address: "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d", decimals: 18, stable: false },
  wBRL: { address: "0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0", decimals: 18, stable: false },
  wMXN: { address: "0x337e7456b420bd3481e7fa61fa9850343d610d34", decimals: 18, stable: false },
  wCOP: { address: "0x8a1d45e102e886510e891d2ec656a708991e2d76", decimals: 18, stable: false },
  wCLP: { address: "0x61D450a098b6a7f69fC4b98CE68198fe59768651", decimals: 18, stable: false },
  wPEN: { address: "0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE", decimals: 18, stable: false },
};
