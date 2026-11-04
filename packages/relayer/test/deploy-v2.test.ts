import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromDataSuffix } from "@celo/attribution-tags";
import { getAddress, http, parseAbi, type Address } from "viem";
import { foundry } from "viem/chains";
import { HACKATHON_ATTRIBUTION_CODE, TEXTILE_REACTOR_CELO } from "@cobra/shared";
import {
  CELO_ROUTER_V2_ARGS,
  ROUTER_V2_ARTIFACT_PATH,
  assertRouterCreation,
  createRouterDeployer,
  loadRouterArtifact,
  routerV2DeployData,
  taggedCreationData,
} from "../src/deploy";
import { ANVIL_KEYS, hasAnvil, startAnvil, type Anvil } from "./helpers";

const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const SWAP_ROUTER = getAddress("0x5615CDAb10dc425a742d643d949a7F474C01abc4");
const REACTOR = getAddress(TEXTILE_REACTOR_CELO);
const artifactReady = existsSync(ROUTER_V2_ARTIFACT_PATH);

describe.skipIf(!artifactReady)("CobraRouterV2 deploy data (forge artifact)", () => {
  it("uses the Celo v1 args plus Textile's reactor", () => {
    expect(CELO_ROUTER_V2_ARGS).toEqual({ permit2: PERMIT2, swapRouter: SWAP_ROUTER, textileReactor: REACTOR });
  });

  it("tagged creation data = initcode ++ 3 constructor args ++ ERC-8021 suffix", () => {
    const art = loadRouterArtifact(ROUTER_V2_ARTIFACT_PATH);
    const data = routerV2DeployData(art, PERMIT2, SWAP_ROUTER, REACTOR);
    expect(data.startsWith(art.bytecode)).toBe(true);
    expect((data.length - art.bytecode.length) / 2).toBe(96);
    const tagged = taggedCreationData(data, HACKATHON_ATTRIBUTION_CODE);
    expect(tagged.startsWith(data)).toBe(true);
    expect(JSON.stringify(fromDataSuffix(tagged))).toContain(HACKATHON_ATTRIBUTION_CODE);
    expect(() => assertRouterCreation({ data: tagged }, art.bytecode)).not.toThrow();
    // the v1 guard refuses v2 initcode and vice versa
    expect(() => assertRouterCreation({ data: tagged }, loadRouterArtifact().bytecode)).toThrow(/wrong_selector/);
  });
});

describe.skipIf(!(hasAnvil && artifactReady))("tagged CobraRouterV2 deployment (anvil)", () => {
  let a: Anvil;
  beforeAll(async () => {
    a = await startAnvil();
  });
  afterAll(async () => a?.stop());

  it("deploys with the ERC-8021 suffix, exactly the dry-run calldata, and correct immutables", async () => {
    const artifact = loadRouterArtifact(ROUTER_V2_ARTIFACT_PATH);
    const d = createRouterDeployer({
      privateKey: ANVIL_KEYS.deployer, rpcUrl: a.url, attributionCode: HACKATHON_ATTRIBUTION_CODE,
      artifact, chain: foundry, transport: http(a.url),
    });
    const hash = await d.deployV2(PERMIT2, SWAP_ROUTER, REACTOR);
    const receipt = await a.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    const router = receipt.contractAddress as Address;

    const tx = await a.publicClient.getTransaction({ hash });
    expect(tx.input).toBe(taggedCreationData(routerV2DeployData(artifact, PERMIT2, SWAP_ROUTER, REACTOR), HACKATHON_ATTRIBUTION_CODE));

    const abi = parseAbi([
      "function PERMIT2() view returns (address)",
      "function SWAP_ROUTER() view returns (address)",
      "function TEXTILE_REACTOR() view returns (address)",
    ]);
    expect(await a.publicClient.readContract({ address: router, abi, functionName: "PERMIT2" })).toBe(PERMIT2);
    expect(await a.publicClient.readContract({ address: router, abi, functionName: "SWAP_ROUTER" })).toBe(SWAP_ROUTER);
    expect(await a.publicClient.readContract({ address: router, abi, functionName: "TEXTILE_REACTOR" })).toBe(REACTOR);
  });
});
