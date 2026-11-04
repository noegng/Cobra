/**
 * @cobra/relayer — WS3. Consumes the `submissions` queue and sends `pay` (plan §5).
 * The ONLY package allowed to hold a private key, and only via ./signer (caps + whitelist).
 * FROZEN public signatures below; internals are yours.
 */
import type { Db, RecordAgentEvent } from "@cobra/db";
import type { Notifier } from "@cobra/shared";
import type { Address, PublicClient, WalletClient } from "viem";
import { runRelayer } from "./relayer";
import type { GasGrantConfig } from "./gas-grant";

export interface RelayerOptions {
  db: Db;
  publicClient: PublicClient;
  walletClient: WalletClient; // built by the worker with withAttribution(ATTRIBUTION_CODE)
  router: Address;
  notifier?: Notifier; // low-balance / error alerts to the operator
  operatorChatId?: string;
  pollIntervalMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** WS15 (additive): structured refusal log (closed codes, no personal data), fire-and-forget. */
  recordEvent?: RecordAgentEvent;
  /** Optional (additive): CELO gas grants for wFIAT payers without gas. Default on; `false` disables. */
  gasGrant?: GasGrantConfig | false;
  /** WS13 (additive): accept Textile RFQ legs (router v2). Default true. */
  allowTextile?: boolean;
  /** WS13 (additive): best-effort report of a broadcast Textile leg (rfqId + tx hash); errors are swallowed. */
  onTextileSent?: (info: { rfqId: string; txHash: `0x${string}` }) => Promise<unknown>;
}

export interface Stoppable {
  stop(): Promise<void>;
}

/**
 * `walletClient` MUST be `createRelayerSigner(...).walletClient` (guarded + attributed); any other client is rejected.
 */
export function startRelayer(opts: RelayerOptions): Stoppable {
  return runRelayer(opts);
}

export {
  createRelayerSigner,
  createRegistrationSender,
  signerOf,
  SignerRefusedError,
  PAY_SELECTOR,
  identityRegistryAbi,
  type RelayerSigner,
  type RelayerSignerOptions,
  type RefusalCode,
  type SendRequest,
  type GasGrantRequest,
  GAS_GRANT_MAX_WEI,
} from "./signer";
export { type RatesSource } from "./rates";
export { claimNext, createRelayer, payCalldata, type RelayerConfig } from "./relayer";
export { verifyLegs } from "./verify";
export { GAS_GRANT_DEFAULTS, findGasGrantCandidates, type GasGrantConfig, type GasGrantCandidate } from "./gas-grant";
export { buildRegistrationFile, registerCalldata, type AgentRegistrationFile } from "./agent";
export { createRouterDeployer, loadRouterArtifact, routerDeployData, assertRouterCreation, CELO_ROUTER_ARGS, ROUTER_ARTIFACT_PATH, type RouterArtifact } from "./deploy";
