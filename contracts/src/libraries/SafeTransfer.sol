// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Tiny safe ERC-20 helpers (Uniswap TransferHelper semantics).
///         - Accept tokens that return nothing (USDT-style) or `true`; revert on `false` or on revert.
///         - Revert if the token has no code (a call to an EOA would otherwise "succeed").
///         - Revert with short string reasons on purpose: custom errors here would leak into
///           CobraRouter's ABI, which must equal packages/shared/src/abi.ts exactly.
library SafeTransfer {
    function safeTransfer(address token, address to, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(0xa9059cbb, to, amount), "ST");
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(0x23b872dd, from, to, amount), "STF");
    }

    function safeApprove(address token, address spender, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(0x095ea7b3, spender, amount), "SA");
    }

    function _call(address token, bytes memory data, string memory reason) private {
        require(token.code.length != 0, reason);
        (bool ok, bytes memory ret) = token.call(data);
        require(ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool)))), reason);
    }
}
