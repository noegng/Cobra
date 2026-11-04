// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IProtocolFeeController} from "../vendor/textile-uniswapx/uniswapx/interfaces/IProtocolFeeController.sol";
import {ResolvedOrder, OutputToken} from "../vendor/textile-uniswapx/uniswapx/base/ReactorStructs.sol";

/// @notice Test fee controller with the observable behaviour of Textile's SellFirstFeeController on Celo
///         (0x7b005466F905DD882A959888154587fA76cd3Ea7, FEE_BPS = 1 read on-chain 2026-11-04): one fee output per
///         distinct output token, `sum * bps / 10_000` to `feeRecipient`, reverts when a fee rounds to zero.
///         Written from the observed behaviour, not copied (Textile's source is BUSL-1.1).
///         `feeOnInput` switches to a fee on the maker's input token (allowed by ProtocolFees) to test fail-closed.
contract MockFeeController is IProtocolFeeController {
    address public immutable feeRecipient;
    uint256 public bps;
    bool public feeOnInput;

    constructor(address feeRecipient_, uint256 bps_) {
        feeRecipient = feeRecipient_;
        bps = bps_;
    }

    function setFeeOnInput(bool v) external {
        feeOnInput = v;
    }

    function getFeeOutputs(ResolvedOrder memory order) external view returns (OutputToken[] memory fees) {
        if (feeOnInput) {
            fees = new OutputToken[](1);
            fees[0] = OutputToken(address(order.input.token), order.input.amount * bps / 10_000, feeRecipient);
            require(fees[0].amount != 0, "FeeRoundsToZero");
            return fees;
        }
        fees = new OutputToken[](order.outputs.length);
        uint256 n;
        for (uint256 i; i < order.outputs.length; ++i) {
            OutputToken memory o = order.outputs[i];
            bool merged;
            for (uint256 j; j < n; ++j) {
                if (fees[j].token == o.token) {
                    fees[j].amount += o.amount;
                    merged = true;
                    break;
                }
            }
            if (!merged) fees[n++] = OutputToken(o.token, o.amount, feeRecipient);
        }
        for (uint256 i; i < n; ++i) {
            fees[i].amount = fees[i].amount * bps / 10_000;
            require(fees[i].amount != 0, "FeeRoundsToZero");
        }
        assembly {
            mstore(fees, n)
        }
    }
}
