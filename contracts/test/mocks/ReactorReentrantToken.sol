// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockERC20} from "./MockERC20.sol";

/// @notice Malicious leg token: when `watch` (the reactor) pulls it with transferFrom, i.e. in the middle of the
///         router's Textile fill, it calls `target` with `payload` once and records the outcome.
contract ReactorReentrantToken is MockERC20 {
    address public watch;
    address public target;
    bytes public payload;
    bool public armed;
    bool public attempted;
    bool public innerSuccess;
    bytes public innerRevertData;

    constructor() MockERC20("Evil", "EVIL", 6) {}

    function arm(address watch_, address target_, bytes calldata payload_) external {
        watch = watch_;
        target = target_;
        payload = payload_;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
        if (armed && msg.sender == watch) {
            armed = false;
            attempted = true;
            (innerSuccess, innerRevertData) = target.call(payload);
        }
        return true;
    }
}
