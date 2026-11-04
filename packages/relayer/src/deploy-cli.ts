/**
 * Tagged CobraRouter deployment CLI (see scripts/agent/deploy-router.ts). DRY RUN unless --execute.
 *   --v2        deploy CobraRouterV2 (Textile FX RFQ venue, docs/interfaces.md §7) instead of v1
 *   --calldata  also print the full tagged creation calldata (initcode ++ ERC-8021 suffix)
 *   --execute   HUMAN ONLY: sign and send with RELAYER_PRIVATE_KEY
 */
import { createPublicClient, http, keccak256, parseAbi, type Address, type Hex } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { toDataSuffix } from "@celo/attribution-tags";
import { CELO_CHAIN_ID, HACKATHON_ATTRIBUTION_CODE } from "@cobra/shared";
import {
  CELO_ROUTER_ARGS,
  CELO_ROUTER_V2_ARGS,
  ROUTER_V2_ARTIFACT_PATH,
  createRouterDeployer,
  loadRouterArtifact,
  routerDeployData,
  routerV2DeployData,
  taggedCreationData,
} from "./deploy";

const REACTOR_ABI = parseAbi(["function permit2() view returns (address)", "function feeController() view returns (address)"]);

export async function runDeployCli(argv: string[], env: Record<string, string | undefined>): Promise<void> {
  const execute = argv.includes("--execute");
  const v2 = argv.includes("--v2");
  const rpcUrl = env.RPC_URL ?? "https://forno.celo.org";
  const code = env.ATTRIBUTION_CODE ?? HACKATHON_ATTRIBUTION_CODE;
  const artifact = v2 ? loadRouterArtifact(ROUTER_V2_ARTIFACT_PATH) : loadRouterArtifact();
  const { permit2, swapRouter } = CELO_ROUTER_ARGS;
  const textileReactor = CELO_ROUTER_V2_ARGS.textileReactor;

  const pub = createPublicClient({ chain: celo, transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  if (chainId !== CELO_CHAIN_ID) throw new Error(`RPC chain id ${chainId} != ${CELO_CHAIN_ID}`);
  const deps: [string, Address][] = [["PERMIT2", permit2], ["SWAP_ROUTER", swapRouter]];
  if (v2) deps.push(["TEXTILE_REACTOR", textileReactor]);
  for (const [n, a] of deps) {
    if (!(await pub.getCode({ address: a }))) throw new Error(`${n} ${a} has no code on Celo`);
  }

  if (!v2) {
    console.log({ chainId, permit2, swapRouter, attributionCode: code, initcodeBytes: (routerDeployData(artifact, permit2, swapRouter).length - 2) / 2 });
  } else {
    // Read-only sanity on the reactor: it must settle through the same canonical Permit2.
    const reactorPermit2 = await pub.readContract({ address: textileReactor, abi: REACTOR_ABI, functionName: "permit2" });
    if (reactorPermit2.toLowerCase() !== permit2.toLowerCase()) {
      throw new Error(`TEXTILE_REACTOR.permit2() ${reactorPermit2} != ${permit2}`);
    }
    const feeController = await pub.readContract({ address: textileReactor, abi: REACTOR_ABI, functionName: "feeController" });
    const deployData = routerV2DeployData(artifact, permit2, swapRouter, textileReactor);
    const tagged = taggedCreationData(deployData, code);
    let estimatedGas: string;
    try {
      estimatedGas = (await pub.estimateGas({ data: tagged })).toString(); // read-only eth_estimateGas
    } catch (e) {
      estimatedGas = `n/a (${String((e as Error).message ?? e).split("\n")[0]})`;
    }
    console.log({
      router: "CobraRouterV2",
      chainId,
      permit2,
      swapRouter,
      textileReactor,
      reactorFeeController: feeController,
      attributionCode: code,
      attributionSuffix: toDataSuffix(code),
      initcodeBytes: (deployData.length - 2) / 2,
      taggedCreationBytes: (tagged.length - 2) / 2,
      taggedCreationKeccak: keccak256(tagged),
      estimatedGas,
    });
    if (argv.includes("--calldata")) console.log(tagged);
  }

  if (!execute) {
    console.log("DRY RUN: nothing sent. Re-run with --execute (human only).");
    return;
  }
  const pk = env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("RELAYER_PRIVATE_KEY missing");
  console.log("deployer (agent wallet):", privateKeyToAccount(pk).address);
  const deployer = createRouterDeployer({ privateKey: pk, rpcUrl, attributionCode: code, artifact });
  const hash = v2 ? await deployer.deployV2(permit2, swapRouter, textileReactor) : await deployer.deploy(permit2, swapRouter);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log({ hash, status: receipt.status, router: receipt.contractAddress, block: receipt.blockNumber });
  console.log(v2 ? "CobraRouterV2 deployed. ROUTER_ADDRESS switch is a separate human decision (docs/interfaces.md §7)." : "Set ROUTER_ADDRESS and ROUTER_DEPLOY_BLOCK from the values above.");
}
