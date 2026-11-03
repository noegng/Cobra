/**
 * Tagged CobraRouter deployment CLI (see scripts/agent/deploy-router.ts). DRY RUN unless --execute.
 */
import { createPublicClient, http, type Hex } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { CELO_CHAIN_ID, HACKATHON_ATTRIBUTION_CODE } from "@cobra/shared";
import { CELO_ROUTER_ARGS, createRouterDeployer, loadRouterArtifact, routerDeployData } from "./deploy";

export async function runDeployCli(argv: string[], env: Record<string, string | undefined>): Promise<void> {
  const execute = argv.includes("--execute");
  const rpcUrl = env.RPC_URL ?? "https://forno.celo.org";
  const code = env.ATTRIBUTION_CODE ?? HACKATHON_ATTRIBUTION_CODE;
  const artifact = loadRouterArtifact();
  const { permit2, swapRouter } = CELO_ROUTER_ARGS;

  const pub = createPublicClient({ chain: celo, transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  if (chainId !== CELO_CHAIN_ID) throw new Error(`RPC chain id ${chainId} != ${CELO_CHAIN_ID}`);
  for (const [n, a] of [["PERMIT2", permit2], ["SWAP_ROUTER", swapRouter]] as const) {
    if (!(await pub.getCode({ address: a }))) throw new Error(`${n} ${a} has no code on Celo`);
  }
  console.log({ chainId, permit2, swapRouter, attributionCode: code, initcodeBytes: (routerDeployData(artifact, permit2, swapRouter).length - 2) / 2 });

  if (!execute) {
    console.log("DRY RUN: nothing sent. Re-run with --execute (human only).");
    return;
  }
  const pk = env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("RELAYER_PRIVATE_KEY missing");
  console.log("deployer (agent wallet):", privateKeyToAccount(pk).address);
  const deployer = createRouterDeployer({ privateKey: pk, rpcUrl, attributionCode: code, artifact });
  const hash = await deployer.deploy(permit2, swapRouter);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log({ hash, status: receipt.status, router: receipt.contractAddress, block: receipt.blockNumber });
  console.log("Set ROUTER_ADDRESS and ROUTER_DEPLOY_BLOCK from the values above.");
}
