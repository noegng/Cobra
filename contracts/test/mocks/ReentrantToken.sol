// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockERC20} from "./MockERC20.sol";

/// @notice Malicious token: on its next transfer it calls `target` with `payload` once (e.g. router.pay of
///         another invoice) and records the outcome. It swallows the inner revert so the test can observe it.
contract ReentrantToken is MockERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    bool public attempted;
    bool public innerSuccess;
    bytes public innerRevertData;

    constructor() MockERC20("Evil", "EVIL", 18) {}

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        if (armed) {
            armed = false;
            attempted = true;
            (innerSuccess, innerRevertData) = target.call(payload);
        }
    }
}
