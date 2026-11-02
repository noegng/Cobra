// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal ERC-20 surface used by CobraRouter. Return values of transfer/transferFrom/approve are
///         deliberately not declared: calls go through SafeTransfer, which tolerates tokens that return nothing.
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
}
