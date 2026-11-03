import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromDataSuffix } from "@celo/attribution-tags";
import { getAddress, http, parseAbi, type Address } from "viem";
import { foundry } from "viem/chains";
import { HACKATHON_ATTRIBUTION_CODE } from "@cobra/shared";
import { ROUTER_ARTIFACT_PATH, assertRouterCreation, createRouterDeployer, loadRouterArtifact } from "../src/deploy";
import { ANVIL_KEYS, hasAnvil, startAnvil, type Anvil } from "./helpers";

const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const SWAP_ROUTER = getAddress("0x5615CDAb10dc425a742d643d949a7F474C01abc4");
const ready = hasAnvil && existsSync(ROUTER_ARTIFACT_PATH);

describe.skipIf(!ready)("tagged CobraRouter deployment (anvil, real forge artifact)", () => {
  let a: Anvil;
  beforeAll(async () => {
    a = await startAnvil();
  });
  afterAll(async () => a?.stop());

  it("deploys with the hackathon ERC-8021 suffix and correct immutables", async () => {
    const artifact = loadRouterArtifact();
    const d = createRouterDeployer({
      privateKey: ANVIL_KEYS.deployer, rpcUrl: a.url, attributionCode: HACKATHON_ATTRIBUTION_CODE,
      artifact, chain: foundry, transport: http(a.url),
    });
    const hash = await d.deploy(PERMIT2, SWAP_ROUTER);
    const receipt = await a.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    const router = receipt.contractAddress as Address;

    const tx = await a.publicClient.getTransaction({ hash });
    const decoded = fromDataSuffix(tx.input);
    expect(JSON.stringify(decoded)).toContain(HACKATHON_ATTRIBUTION_CODE);

    const abi = parseAbi(["function PERMIT2() view returns (address)", "function SWAP_ROUTER() view returns (address)"]);
    expect(await a.publicClient.readContract({ address: router, abi, functionName: "PERMIT2" })).toBe(PERMIT2);
    expect(await a.publicClient.readContract({ address: router, abi, functionName: "SWAP_ROUTER" })).toBe(SWAP_ROUTER);
  });

  it("guard refuses calls, other initcode and value", () => {
    const { bytecode } = loadRouterArtifact();
    const data = `${bytecode}${"00".repeat(64)}` as const;
    expect(() => assertRouterCreation({ data }, bytecode)).not.toThrow();
    expect(() => assertRouterCreation({ to: PERMIT2, data }, bytecode)).toThrow(/wrong_target/);
    expect(() => assertRouterCreation({ data: "0x6080604052" }, bytecode)).toThrow(/wrong_selector/);
    expect(() => assertRouterCreation({ data, value: 1n }, bytecode)).toThrow(/value_not_zero/);
  });
});
