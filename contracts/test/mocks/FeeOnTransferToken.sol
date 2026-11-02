// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockERC20} from "./MockERC20.sol";

/// @notice Burns `feeBps` of every transfer (recipient receives amount - fee).
contract FeeOnTransferToken is MockERC20 {
    uint256 public feeBps;

    constructor(uint256 feeBps_) MockERC20("Fee Token", "FOT", 18) {
        feeBps = feeBps_;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "ERC20: balance");
        uint256 fee = amount * feeBps / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }
}
