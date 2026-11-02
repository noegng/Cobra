// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice SwapRouter02 stand-in. Pulls `amountIn * consumeBps / 1e4` of the first path token from msg.sender
///         (consumeBps < 1e4 simulates a partial fill at the pool's price limit) and MINTS `pulled * num / den`
///         of the last path token to `recipient`. Rates are set per (tokenIn, tokenOut) pair; default 1:1.
contract MockSwapRouter is ISwapRouter02 {
    struct Rate {
        uint256 num;
        uint256 den;
        bool set;
    }

    mapping(address => mapping(address => Rate)) public rates;
    uint256 public consumeBps = 10_000;
    uint256 public calls;

    function setRate(address tokenIn, address tokenOut, uint256 num, uint256 den) external {
        rates[tokenIn][tokenOut] = Rate(num, den, true);
    }

    function setConsumeBps(uint256 bps) external {
        consumeBps = bps;
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        Rate memory r = rates[tokenIn][tokenOut];
        return r.set ? amountIn * r.num / r.den : amountIn;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        bytes calldata path = params.path;
        require(path.length >= 43 && (path.length - 20) % 23 == 0, "MockSwapRouter: path");
        address tokenIn = address(bytes20(path[:20]));
        address tokenOut = address(bytes20(path[path.length - 20:]));
        uint256 pulled = params.amountIn * consumeBps / 10_000;
        MockERC20(tokenIn).transferFrom(msg.sender, address(this), pulled);
        amountOut = quote(tokenIn, tokenOut, pulled);
        require(amountOut >= params.amountOutMinimum, "Too little received");
        MockERC20(tokenOut).mint(params.recipient, amountOut);
        calls++;
    }
}
