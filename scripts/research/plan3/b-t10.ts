/**
 * Plan 3 / sub-agent B — T10: Ripio BridgeDeposit configuration (read-only).
 * Usage (repo root): pnpm exec tsx scripts/research/plan3/b-t10.ts  -> docs/research/plan3/b-t10.json
 * Source: https://github.com/ripio/latam-stables/blob/main/src/BridgeDeposit.sol ; address from bridge.ripio.com/developers.
 * Reads on each chain where the contract has code: paused, limitedMinter, feeCollector, nextDepositId, routeConfigs(token, destChain),
 * remainingMintCapacity(token), limitedMinter.tokenConfigs/mintedToday.
 */
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { writeFileSync } from "node:fs";
import { TOKENS } from "./b-common.ts";
const BRIDGE: Address = "0x465e642387d3d73a57CDc1368fFA53A800bA5D47";
const chains: Record<string, { id: number; rpc: string }> = {
  celo: { id: 42220, rpc: "https://forno.celo.org" }, ethereum: { id: 1, rpc: "https://ethereum-rpc.publicnode.com" },
  base: { id: 8453, rpc: "https://mainnet.base.org" }, polygon: { id: 137, rpc: "https://polygon-bor-rpc.publicnode.com" }, bsc: { id: 56, rpc: "https://bsc-rpc.publicnode.com" },
  arbitrum: { id: 42161, rpc: "https://arb1.arbitrum.io/rpc" }, optimism: { id: 10, rpc: "https://mainnet.optimism.io" },
};
const abi = parseAbi([
  "function paused() view returns (bool)", "function limitedMinter() view returns (address)", "function feeCollector() view returns (address)", "function nextDepositId() view returns (uint256)",
  "function routeConfigs(address,uint256) view returns (bool enabled,uint256 fixedFee)", "function remainingMintCapacity(address) view returns (uint256)",
]);
const mAbi = parseAbi(["function tokenConfigs(address) view returns (uint256 dailyMaxMint,bool exists)", "function mintedToday(address) view returns (uint256)"]);
const wf = Object.entries(TOKENS).filter(([, t]) => !t.stable);
const out: any = { bridge: BRIDGE, chains: {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tryRead = async (f: () => Promise<any>) => { try { return await f(); } catch (e: any) { return { error: String(e.shortMessage ?? e.message).split("\n")[0].slice(0, 100) }; } };
for (const [name, ch] of Object.entries(chains)) {
  const c = createPublicClient({ transport: http(ch.rpc) });
  const code = await tryRead(() => c.getCode({ address: BRIDGE }));
  const o: any = { chainId: ch.id, hasCode: typeof code === "string" && code.length > 2 };
  if (!o.hasCode) { out.chains[name] = o; continue; }
  const rd = (fn: any, args: any[] = []) => tryRead(() => c.readContract({ address: BRIDGE, abi, functionName: fn, args } as any));
  o.block = (await c.getBlockNumber()).toString();
  o.paused = await rd("paused"); o.feeCollector = await rd("feeCollector"); o.nextDepositId = String(await rd("nextDepositId"));
  const lm = await rd("limitedMinter"); o.limitedMinter = lm; o.tokens = {};
  for (const [sym, t] of wf) {
    const row: any = { address: t.address, routes: {}, tokenHasCode: false };
    row.tokenHasCode = ((await tryRead(() => c.getCode({ address: t.address }))) as any)?.length > 2;
    for (const [dn, dch] of Object.entries(chains)) {
      if (dch.id === ch.id) continue;
      const r = await rd("routeConfigs", [t.address, BigInt(dch.id)]);
      row.routes[dn] = r.error ? r : { enabled: r[0], fixedFee: r[1].toString() };
      await sleep(60);
    }
    const cap = await rd("remainingMintCapacity", [t.address]); row.remainingMintCapacity = cap.error ? cap : cap.toString();
    if (typeof lm === "string") {
      const tc = await tryRead(() => c.readContract({ address: lm as Address, abi: mAbi, functionName: "tokenConfigs", args: [t.address] }));
      const md = await tryRead(() => c.readContract({ address: lm as Address, abi: mAbi, functionName: "mintedToday", args: [t.address] }));
      row.dailyMaxMint = (tc as any).error ? tc : (tc as any)[0].toString(); row.mintConfigured = (tc as any).error ? null : (tc as any)[1]; row.mintedToday = (md as any).error ? md : String(md);
    }
    o.tokens[sym] = row;
  }
  out.chains[name] = o; console.log(name, "paused", o.paused, "minter", lm);
}
writeFileSync("docs/research/plan3/b-t10.json", JSON.stringify(out, null, 1));
for (const [n, o] of Object.entries<any>(out.chains)) for (const [s, t] of Object.entries<any>(o.tokens ?? {})) console.log(n, s, JSON.stringify(t.routes), "cap", t.remainingMintCapacity, "daily", t.dailyMaxMint, "minted", t.mintedToday);
