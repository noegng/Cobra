// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Test-only stand-in for CobraRouter (WS1 builds the real one). Same ABI for everything the relayer touches:
/// pay / isPaid / hashInvoice (EIP-712 struct hash) / Paid / errors. It does NOT move tokens.
/// Test hook: amountOut == 0xdead reverts with InsufficientOutput so simulation failures can be exercised.
contract MockRouter {
    struct Invoice {
        bytes32 id;
        address merchant;
        address tokenOut;
        uint256 amountOut;
        uint256 deadline;
    }

    struct Leg {
        address token;
        uint256 amountIn;
        uint8 kind;
        bytes pullData;
        bytes path;
    }

    bytes32 internal constant INVOICE_TYPEHASH =
        keccak256("Invoice(bytes32 id,address merchant,address tokenOut,uint256 amountOut,uint256 deadline)");

    mapping(bytes32 => bool) public isPaid;
    uint256 public payCount;

    event Paid(
        bytes32 indexed invoiceId, address indexed payer, address indexed merchant, address tokenOut, uint256 amountOut
    );

    error Expired();
    error AlreadyPaid();
    error InvalidLegs();
    error InsufficientOutput(uint256 got, uint256 want);

    function hashInvoice(Invoice calldata inv) public pure returns (bytes32) {
        return keccak256(abi.encode(INVOICE_TYPEHASH, inv.id, inv.merchant, inv.tokenOut, inv.amountOut, inv.deadline));
    }

    function pay(Invoice calldata inv, address payer, Leg[] calldata legs) external {
        if (block.timestamp > inv.deadline) revert Expired();
        if (legs.length == 0 || legs.length > 3) revert InvalidLegs();
        bytes32 h = hashInvoice(inv);
        if (isPaid[h]) revert AlreadyPaid();
        if (inv.amountOut == 0xdead) revert InsufficientOutput(1, inv.amountOut);
        isPaid[h] = true;
        payCount++;
        emit Paid(inv.id, payer, inv.merchant, inv.tokenOut, inv.amountOut);
    }
}

/// Only exposes an EIP-712 DOMAIN_SEPARATOR so the relayer's on-chain domain fallback can be exercised.
contract MockEip3009Token {
    bytes32 public immutable DOMAIN_SEPARATOR;

    constructor(string memory name, string memory version) {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }
}

/// Minimal ERC-1271 wallet: a signature is valid iff it is an ECDSA signature by `owner` over the hash.
contract Mock1271Wallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(hash, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
