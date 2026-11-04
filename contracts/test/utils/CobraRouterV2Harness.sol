// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CobraRouterV2} from "../../src/CobraRouterV2.sol";
import {IUniswapXReactor} from "../../src/interfaces/IUniswapXReactor.sol";

/// @notice Test-only: exposes CobraRouterV2's internal constants and helpers (same names as CobraRouterHarness so the
///         v1 vector suite runs unchanged against v2).
contract CobraRouterV2Harness is CobraRouterV2 {
    constructor(address permit2, address swapRouter, address textileReactor)
        CobraRouterV2(permit2, swapRouter, textileReactor)
    {}

    function exposed_INVOICE_TYPEHASH() external pure returns (bytes32) {
        return INVOICE_TYPEHASH;
    }

    function exposed_LEG_COMMITMENT_TYPEHASH() external pure returns (bytes32) {
        return LEG_COMMITMENT_TYPEHASH;
    }

    function exposed_PAYMENT_INTENT_TYPEHASH() external pure returns (bytes32) {
        return PAYMENT_INTENT_TYPEHASH;
    }

    function exposed_PERMIT2_WITNESS_TYPE_STRING() external pure returns (string memory) {
        return PERMIT2_WITNESS_TYPE_STRING;
    }

    function exposed_legNonce(bytes32 digest, uint256 index) external pure returns (bytes32) {
        return _legNonce(digest, index);
    }

    function exposed_isTextileVenue(bytes calldata path) external pure returns (bool) {
        return _isTextileVenue(path);
    }

    function exposed_decodeTextileOrders(bytes calldata path, address tokenIn, address tokenOut)
        external
        view
        returns (IUniswapXReactor.SignedOrder[] memory)
    {
        return _decodeTextileOrders(path, tokenIn, tokenOut);
    }
}
