/**
 * ERC-8004 registration CLI logic (entry point: scripts/agent/register.ts).
 *
 * Default = DRY RUN: builds and prints the agent card JSON, the agentURI and the `register(string)` calldata.
 * `--execute` (human only): reads RELAYER_PRIVATE_KEY / RPC_URL / ATTRIBUTION_CODE from env, checks chain 42220,
 * checks the card is live at the agentURI, simulates, then sends through the narrow registration sender.
 */
import { writeFileSync } from "node:fs";
import { codeFromHostname } from "@celo/attribution-tags";
import { createPublicClient, getAddress, http, isAddress, parseEventLogs, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { CELO, CELO_CHAIN_ID } from "@cobra/shared";
import { agentCardUrl, buildRegistrationFile, registerCalldata, type AgentRegistrationFile } from "./agent";
import { createRegistrationSender, identityRegistryAbi } from "./signer";

interface Args {
  baseUrl: string;
  uri?: string;
  wallet?: Address;
  agentId?: number;
  write?: string;
  execute: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const baseUrl = get("base-url");
  if (!baseUrl || !/^https:\/\//.test(baseUrl)) throw new Error("--base-url https://<public host> is required");
  const wallet = get("wallet");
  if (wallet && !isAddress(wallet, { strict: false })) throw new Error("--wallet must be an address");
  const agentId = get("agent-id");
  return {
    baseUrl,
    ...(get("uri") && { uri: get("uri")! }),
    ...(wallet && { wallet: getAddress(wallet) }),
    ...(agentId !== undefined && { agentId: Number(agentId) }),
    ...(argv.includes("--write") && { write: get("write") && !get("write")!.startsWith("--") ? get("write")! : "docs/agent/registration.json" }),
    execute: argv.includes("--execute"),
  };
}

const print = (label: string, v: unknown) => console.log(`\n# ${label}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`);

export async function runRegisterCli(argv: readonly string[], env: Record<string, string | undefined>): Promise<void> {
  const a = parseArgs(argv);
  const registry = CELO.erc8004.identityRegistry.address;
  const agentURI = a.uri ?? agentCardUrl(a.baseUrl);
  const host = new URL(a.baseUrl).hostname;

  let wallet = a.wallet;
  let key: Hex | undefined;
  if (a.execute) {
    const k = env.RELAYER_PRIVATE_KEY;
    if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("--execute needs RELAYER_PRIVATE_KEY (0x + 64 hex) in env");
    key = k as Hex;
    wallet = privateKeyToAccount(key).address; // the agent wallet == the relayer wallet (register() sets msg.sender)
  }

  const card = buildRegistrationFile({ publicBaseUrl: a.baseUrl, ...(wallet && { wallet }), ...(a.agentId !== undefined && { agentId: a.agentId }) });
  print("agent card (serve at agentURI; web app: /.well-known/agent-registration.json)", card);
  print("agentURI", agentURI);
  print("IdentityRegistry (Celo 42220)", registry);
  print("calldata register(string)", registerCalldata(agentURI));
  print("suggested ATTRIBUTION_CODE (codeFromHostname)", codeFromHostname(host));
  if (a.write) {
    writeFileSync(a.write, JSON.stringify(card, null, 2) + "\n");
    print("written", a.write);
  }
  if (!a.execute) {
    console.log("\nDRY RUN: nothing was sent. Re-run with --execute (human only) to register.");
    return;
  }

  const rpcUrl = env.RPC_URL ?? CELO.rpcUrl;
  const attributionCode = env.ATTRIBUTION_CODE;
  if (!attributionCode) throw new Error("--execute needs ATTRIBUTION_CODE in env");
  const pc = createPublicClient({ chain: celo, transport: http(rpcUrl) });
  const chainId = await pc.getChainId();
  if (chainId !== CELO_CHAIN_ID) throw new Error(`RPC chain id ${chainId} != 42220`);

  // The card must already be live and name this wallet, otherwise explorers index a broken identity.
  const res = await fetch(agentURI, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`agentURI not reachable (${res.status}): deploy the web app first`);
  const live = (await res.json()) as AgentRegistrationFile;
  if (live.type !== card.type || !live.services?.some((s) => s.name === "agentWallet" && s.endpoint.endsWith(wallet!))) {
    throw new Error("live agent card does not match (type / agentWallet). Re-run with --write and redeploy the web app.");
  }

  const sender = createRegistrationSender({ privateKey: key!, rpcUrl, attributionCode });
  const sim = await pc.simulateContract({ account: sender.address, address: registry, abi: identityRegistryAbi, functionName: "register", args: [agentURI] });
  print("simulated agentId", String(sim.result));
  const balance = await pc.getBalance({ address: sender.address });
  print("wallet / CELO balance (wei)", `${sender.address} / ${balance}`);

  const hash = await sender.register(agentURI);
  print("tx", `${CELO.explorer}/tx/${hash}`);
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("registration reverted");
  const minted = parseEventLogs({ abi: identityRegistryAbi, logs: receipt.logs, eventName: "Transfer" }).find(
    (l) => l.address.toLowerCase() === registry.toLowerCase() && /^0x0+$/.test(l.args.from),
  );
  const agentId = minted ? Number(minted.args.tokenId) : Number(sim.result);
  const final = buildRegistrationFile({ publicBaseUrl: a.baseUrl, wallet: sender.address, agentId });
  print(`registered: agentId ${agentId}. Updated card (add to the web app, redeploy)`, final);
  if (a.write) writeFileSync(a.write, JSON.stringify(final, null, 2) + "\n");
}
