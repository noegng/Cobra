// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IValidationCallback} from "../vendor/textile-uniswapx/uniswapx/interfaces/IValidationCallback.sol";
import {ResolvedOrder} from "../vendor/textile-uniswapx/uniswapx/base/ReactorStructs.sol";

/// @notice Same rule as Textile's PreferredFillerValidation (Celo 0x10B9EbA3a175Df418a35CB8329a527691EE258C5,
///         BUSL-1.1, re-implemented from its verified behaviour): additionalValidationData =
///         abi.encode(address[] preferredFillers, uint256 exclusiveUntil); until `exclusiveUntil` only a listed
///         filler may fill.
contract MockFillerValidation is IValidationCallback {
    function validate(address filler, ResolvedOrder calldata order) external view {
        require(msg.sender == address(order.info.reactor), "InvalidCaller");
        (address[] memory fillers, uint256 exclusiveUntil) =
            abi.decode(order.info.additionalValidationData, (address[], uint256));
        require(fillers.length != 0 && fillers.length <= 10, "InvalidPreferredFillerCount");
        if (block.timestamp > exclusiveUntil) return;
        for (uint256 i; i < fillers.length; ++i) {
            if (fillers[i] == filler) return;
        }
        revert("FillerNotPreferred");
    }
}
