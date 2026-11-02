import { parseAbi } from "viem";

/**
 * FROZEN router ABI (WS0). contracts/src/ICobraRouter.sol MUST match this exactly;
 * `contracts/test/AbiParity.t.sol` + `packages/shared/test/abi-parity.test.ts` enforce it.
 */
export const cobraRouterAbi = parseAbi([
  "struct Invoice { bytes32 id; address merchant; address tokenOut; uint256 amountOut; uint256 deadline; }",
  "struct Leg { address token; uint256 amountIn; uint8 kind; bytes pullData; bytes path; }",

  "function pay(Invoice inv, address payer, Leg[] legs)",

  "function isPaid(bytes32 invoiceHash) view returns (bool)",
  "function hashInvoice(Invoice inv) pure returns (bytes32)",
  "function hashIntent(Invoice inv, address payer, Leg[] legs) pure returns (bytes32)",
  "function intentDigest(Invoice inv, address payer, Leg[] legs) view returns (bytes32)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function PERMIT2() view returns (address)",
  "function SWAP_ROUTER() view returns (address)",

  "event Paid(bytes32 indexed invoiceId, address indexed payer, address indexed merchant, address tokenOut, uint256 amountOut)",

  "error Expired()",
  "error AlreadyPaid()",
  "error InvalidLegs()",
  "error InvalidPath()",
  "error PayerMustBeSender()",
  "error InsufficientOutput(uint256 got, uint256 want)",
]);

/** Minimal ERC-20 + EIP-2612 + EIP-3009 surface used across packages. */
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
