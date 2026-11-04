/**
 * CobraRouter deployment from the agent wallet, ERC-8021-tagged (the hackathon credits only tagged txs,
 * the deployment included). Forge's Deploy.s.sol cannot append the data suffix, so mainnet deployment
 * goes through here. The trailing suffix after the ABI-encoded constructor args is ignored by the
 * constructor (static args are decoded by offset) — covered by test/deploy.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  concatHex,
  createWalletClient,
  encodeDeployData,
  getAddress,
  http,
  zeroAddress,
  type Abi,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { toDataSuffix, withAttribution } from "@celo/attribution-tags";
import { CELO, TEXTILE_REACTOR_CELO } from "@cobra/shared";
import { SignerRefusedError } from "./signer";

export interface RouterArtifact {
  abi: Abi;
  bytecode: Hex;
}

export const ROUTER_ARTIFACT_PATH = resolve(import.meta.dirname, "../../../contracts/out/CobraRouter.sol/CobraRouter.json");

/** Reads the forge artifact (run `forge build` in contracts/ first). */
export function loadRouterArtifact(path = ROUTER_ARTIFACT_PATH): RouterArtifact {
  const j = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export const CELO_ROUTER_ARGS = {
  permit2: CELO.permit2.address,
  swapRouter: CELO.uniswapV3.swapRouter.address,
} as const;

export function routerDeployData(art: RouterArtifact, permit2: Address, swapRouter: Address): Hex {
  return encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: [getAddress(permit2), getAddress(swapRouter)] });
}

// ───────────── CobraRouterV2 (Textile FX RFQ venue, docs/interfaces.md §7) ─────────────

export const ROUTER_V2_ARTIFACT_PATH = resolve(
  import.meta.dirname,
  "../../../contracts/out/CobraRouterV2.sol/CobraRouterV2.json",
);

/** v1 args + Textile's UniswapX LimitOrderReactor on Celo. */
export const CELO_ROUTER_V2_ARGS = {
  ...CELO_ROUTER_ARGS,
  textileReactor: getAddress(TEXTILE_REACTOR_CELO),
} as const;

/** constructor(address permit2, address swapRouter, address textileReactor). */
export function routerV2DeployData(art: RouterArtifact, permit2: Address, swapRouter: Address, textileReactor: Address): Hex {
  return encodeDeployData({
    abi: art.abi,
    bytecode: art.bytecode,
    args: [getAddress(permit2), getAddress(swapRouter), getAddress(textileReactor)],
  });
}

/** The exact creation calldata `withAttribution` sends: initcode ++ ERC-8021 suffix (ignored by the constructor). */
export function taggedCreationData(deployData: Hex, attributionCode: string): Hex {
  return concatHex([deployData, toDataSuffix(attributionCode) as Hex]);
}

export interface RouterDeployerOptions {
  privateKey: Hex;
  rpcUrl: string;
  attributionCode: string;
  artifact: RouterArtifact;
  chain?: Chain;
  transport?: Transport;
}

/** Guard used by the deployer's signer: only a zero-value contract creation of the CobraRouter initcode. */
export function assertRouterCreation(tx: { to?: Address | null; data?: Hex; value?: bigint }, creationBytecode: Hex): void {
  if (tx.to && tx.to !== zeroAddress) throw new SignerRefusedError("wrong_target");
  if (!tx.data || !tx.data.toLowerCase().startsWith(creationBytecode.toLowerCase())) throw new SignerRefusedError("wrong_selector");
  if (tx.value && tx.value !== 0n) throw new SignerRefusedError("value_not_zero");
}

/** Narrow sender: can ONLY sign a contract creation whose initcode is the CobraRouter creation bytecode. */
export function createRouterDeployer(opts: RouterDeployerOptions) {
  const key = privateKeyToAccount(opts.privateKey);
  const chain = opts.chain ?? celo;
  const refuse = () => {
    throw new SignerRefusedError("wrong_selector");
  };
  const account = toAccount({
    address: key.address,
    signMessage: refuse,
    signTypedData: refuse,
    async signTransaction(tx, o) {
      assertRouterCreation(tx, opts.artifact.bytecode);
      return key.signTransaction(tx, o);
    },
  });
  const client = createWalletClient({ account, chain, transport: opts.transport ?? http(opts.rpcUrl) }).extend(
    withAttribution(opts.attributionCode),
  );
  return {
    address: key.address,
    /** Sends the tagged creation tx. Goes through the attributed sendTransaction (suffix appended). */
    deploy(permit2: Address, swapRouter: Address): Promise<Hash> {
      const data = routerDeployData(opts.artifact, permit2, swapRouter);
      return client.sendTransaction({ account, chain, data } as never);
    },
    /** v2: same narrow signer, CobraRouterV2 artifact expected in `opts.artifact`. */
    deployV2(permit2: Address, swapRouter: Address, textileReactor: Address): Promise<Hash> {
      const data = routerV2DeployData(opts.artifact, permit2, swapRouter, textileReactor);
      return client.sendTransaction({ account, chain, data } as never);
    },
  };
}
