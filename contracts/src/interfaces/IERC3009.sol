// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice EIP-3009 `receiveWithAuthorization` (v, r, s variant). Requires msg.sender == to.
///         Verified on Celo for USDC, USD₮ and USAT (docs/research/onchain-verification.md §4).
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
