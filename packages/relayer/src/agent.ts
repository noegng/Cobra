/**
 * ERC-8004 agent identity for the relayer wallet (pure builders, no network, no key).
 * Spec: https://eips.ethereum.org/EIPS/eip-8004 (registration-v1). Registry: CELO.erc8004.identityRegistry.
 */
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { CELO, CELO_CHAIN_ID } from "@cobra/shared";
import { identityRegistryAbi } from "./signer";

export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1" as const;

export interface AgentRegistrationFile {
  type: typeof REGISTRATION_TYPE;
  name: string;
  description: string;
  image: string;
  services: { name: string; endpoint: string; version?: string }[];
  x402Support: boolean;
  active: boolean;
  registrations: { agentId: number; agentRegistry: string }[];
  supportedTrust: string[];
}

export function agentRegistryId(registry: Address = CELO.erc8004.identityRegistry.address, chainId: number = CELO_CHAIN_ID) {
  return `eip155:${chainId}:${getAddress(registry)}`;
}

/** Where the web app serves the card (8004scan domain proof location). */
export function agentCardUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/.well-known/agent-registration.json`;
}

export function buildRegistrationFile(args: {
  publicBaseUrl: string;
  /** Relayer wallet (public address). Omit to leave the agentWallet service out. */
  wallet?: Address;
  agentId?: number;
  registry?: Address;
  chainId?: number;
}): AgentRegistrationFile {
  const base = args.publicBaseUrl.replace(/\/+$/, "");
  const services: AgentRegistrationFile["services"] = [{ name: "web", endpoint: `${base}/` }];
  if (args.wallet) services.push({ name: "agentWallet", endpoint: `eip155:${args.chainId ?? CELO_CHAIN_ID}:${getAddress(args.wallet)}` });
  return {
    type: REGISTRATION_TYPE,
    name: "Cobrá Relayer",
    description:
      "Cobrá is a LatAm merchant checkout on Celo. Merchants create invoices in local currency from Telegram; payers sign " +
      "once (EIP-3009 or Permit2, bound to the full payment intent) and this agent relays CobraRouter.pay(), paying the " +
      "gas, so the merchant receives the exact wFIAT amount. It can only submit the exact signed intent (it cannot change " +
      "merchant, amount, token, path or split), enforces per-payment and per-day USD caps, and tags every tx with ERC-8021.",
    image: `${base}/agent.png`,
    services,
    x402Support: false,
    active: true,
    registrations:
      args.agentId !== undefined ? [{ agentId: args.agentId, agentRegistry: agentRegistryId(args.registry, args.chainId) }] : [],
    supportedTrust: ["reputation"],
  };
}

/** Calldata for IdentityRegistry.register(string agentURI). */
export function registerCalldata(agentURI: string): Hex {
  return encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [agentURI] });
}
