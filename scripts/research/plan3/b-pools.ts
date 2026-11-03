/**
 * Plan 3 / sub-agent B — pool discovery (read-only).
 * Usage (repo root): pnpm exec tsx scripts/research/plan3/b-pools.ts   -> writes docs/research/plan3/b-pools.json
 * Lists every existing Uniswap V3 pool among {USDC, USDT, USAT, 6 wFIAT} for fees 100/500/3000/10000 with slot0 + liquidity.
 */
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { writeFileSync } from "node:fs";
import { TOKENS, FEES, FACTORY } from "./b-common.ts";

const c = createPublicClient({ transport: http("https://forno.celo.org", { batch: true }), batch: { multicall: true } });
const fAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const pAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
]);
const syms = Object.keys(TOKENS);
const out: any[] = [];
const block = await c.getBlock();
for (let i = 0; i < syms.length; i++)
  for (let j = i + 1; j < syms.length; j++)
    for (const fee of FEES) {
      const a = TOKENS[syms[i]].address, b = TOKENS[syms[j]].address;
      const pool = (await c.readContract({ address: FACTORY, abi: fAbi, functionName: "getPool", args: [a, b, fee], blockNumber: block.number })) as Address;
      if (/^0x0+$/.test(pool)) continue;
      const [s0, liq, t0] = await Promise.all([
        c.readContract({ address: pool, abi: pAbi, functionName: "slot0", blockNumber: block.number }),
        c.readContract({ address: pool, abi: pAbi, functionName: "liquidity", blockNumber: block.number }),
        c.readContract({ address: pool, abi: pAbi, functionName: "token0", blockNumber: block.number }),
      ]);
      out.push({ a: syms[i], b: syms[j], fee, pool, token0: t0, sqrtPriceX96: s0[0].toString(), tick: s0[1], liquidity: liq.toString() });
    }
writeFileSync("docs/research/plan3/b-pools.json", JSON.stringify({ block: block.number.toString(), timestamp: Number(block.timestamp), pools: out }, null, 1));
for (const p of out) console.log(p.a, p.b, p.fee, p.pool, "liq", p.liquidity);
