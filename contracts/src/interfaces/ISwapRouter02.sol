// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal subset of Uniswap SwapRouter02 (Celo 0x5615CDAb10dc425a742d643d949a7F474C01abc4).
///         SwapRouter02's ExactInputParams has NO deadline field (selector 0xb858183f).
interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}
