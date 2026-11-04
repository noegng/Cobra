// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice ABI-compatible declarations of the UniswapX types and entry points CobraRouterV2 needs.
///         Struct layouts mirror UniswapX `ReactorStructs.sol` / `LimitOrderLib.sol` as verified on Celoscan for
///         Textile's LimitOrderReactor 0xa9aa0a64769cbed4d3b1ceb4df01cde915c235b3 (solc 0.8.30). Declarations only:
///         no UniswapX (GPL-2.0-or-later) code is compiled into the router. Wrapped in an interface so the struct
///         names do not clash with the vendored test reactor's file-level structs.
interface IUniswapXReactor {
    struct OrderInfo {
        address reactor;
        address swapper;
        uint256 nonce;
        uint256 deadline;
        address additionalValidationContract;
        bytes additionalValidationData;
    }

    struct InputToken {
        address token;
        uint256 amount;
        uint256 maxAmount;
    }

    struct OutputToken {
        address token;
        uint256 amount;
        address recipient;
    }

    struct ResolvedOrder {
        OrderInfo info;
        InputToken input;
        OutputToken[] outputs;
        bytes sig;
        bytes32 hash;
    }

    struct SignedOrder {
        bytes order;
        bytes sig;
    }

    /// @dev `SignedOrder.order` of a LimitOrderReactor is `abi.encode(LimitOrder)`.
    struct LimitOrder {
        OrderInfo info;
        InputToken input;
        OutputToken[] outputs;
    }

    /// @dev BaseReactor: resolve + inject fees + validate(filler) + pull each maker input to msg.sender, then
    ///      IReactorCallback(msg.sender).reactorCallback, then pull every output (+ protocol fee) from msg.sender.
    function executeBatchWithCallback(SignedOrder[] calldata orders, bytes calldata callbackData) external payable;
}

/// @notice UniswapX filler callback (selector must match the reactor's IReactorCallback).
interface IReactorCallback {
    function reactorCallback(IUniswapXReactor.ResolvedOrder[] calldata resolvedOrders, bytes calldata callbackData)
        external;
}
