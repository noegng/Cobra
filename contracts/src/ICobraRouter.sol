// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ICobraRouter — FROZEN interface (WS0)
/// @notice Must stay byte-for-byte ABI-compatible with packages/shared/src/abi.ts.
///         Signing scheme: docs/interfaces.md §3.
interface ICobraRouter {
    /// @dev Order is ABI-significant (uint8 on the wire).
    enum PullKind {
        EIP3009,
        PERMIT2,
        ALLOWANCE
    }

    struct Leg {
        address token; // asset pulled from the payer
        uint256 amountIn; // exact amount pulled
        PullKind kind; // pull mechanism
        bytes pullData; // EIP3009: abi.encode(validAfter, validBefore, v, r, s)
        //                 PERMIT2: abi.encode(nonce, deadline, signature)
        //                 ALLOWANCE: empty, requires msg.sender == payer
        bytes path; // Uniswap V3 path tokenIn..tokenOut, empty iff token == tokenOut
    }

    struct Invoice {
        bytes32 id;
        address merchant;
        address tokenOut; // wFIAT or settlement stablecoin
        uint256 amountOut; // exact amount paid to the merchant
        uint256 deadline;
    }

    event Paid(
        bytes32 indexed invoiceId, address indexed payer, address indexed merchant, address tokenOut, uint256 amountOut
    );

    error Expired();
    error AlreadyPaid();
    error InvalidLegs();
    error InvalidPath();
    error PayerMustBeSender();
    error InsufficientOutput(uint256 got, uint256 want);

    /// @notice Pull every leg from `payer`, swap to `inv.tokenOut`, pay exactly `inv.amountOut`
    ///         to `inv.merchant`, refund any surplus to `payer`. Reverts entirely otherwise.
    function pay(Invoice calldata inv, address payer, Leg[] calldata legs) external;

    /// @notice Keyed by hashInvoice(inv) (EIP-712 struct hash), NOT by inv.id,
    ///         so a third party cannot grief an id by front-running with different terms.
    function isPaid(bytes32 invoiceHash) external view returns (bool);

    function hashInvoice(Invoice calldata inv) external pure returns (bytes32);
    function hashIntent(Invoice calldata inv, address payer, Leg[] calldata legs) external pure returns (bytes32);
    function intentDigest(Invoice calldata inv, address payer, Leg[] calldata legs) external view returns (bytes32);

    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function PERMIT2() external view returns (address);
    function SWAP_ROUTER() external view returns (address);
}
