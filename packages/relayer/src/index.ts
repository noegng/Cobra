/**
 * @cobra/relayer — WS3. Consumes the `submissions` queue and sends `pay` (plan §5).
 * The ONLY package allowed to hold a private key, and only via ./signer (caps + whitelist).
 * FROZEN public signatures below; internals are yours.
 */
import type { Db } from "@cobra/db";
import type { Notifier } from "@cobra/shared";
import type { Address, PublicClient, WalletClient } from "viem";

export interface RelayerOptions {
  db: Db;
  publicClient: PublicClient;
  walletClient: WalletClient; // built by the worker with withAttribution(ATTRIBUTION_CODE)
  router: Address;
  notifier?: Notifier; // low-balance / error alerts to the operator
  operatorChatId?: string;
  pollIntervalMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Stoppable {
  stop(): Promise<void>;
}

export function startRelayer(_opts: RelayerOptions): Stoppable {
  throw new Error("not implemented (WS3)");
}
