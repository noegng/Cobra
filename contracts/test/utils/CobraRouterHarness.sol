// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CobraRouter} from "../../src/CobraRouter.sol";

/// @notice Test-only: exposes CobraRouter's internal constants and helpers (not part of the production ABI).
contract CobraRouterHarness is CobraRouter {
    constructor(address permit2, address swapRouter) CobraRouter(permit2, swapRouter) {}

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
}
