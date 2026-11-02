// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Test-only stand-in for CobraRouter: emits the exact `Paid` event of ICobraRouter.sol.
// Rebuild the bytecode in paid-emitter.ts with `pnpm --filter @cobra/indexer fixture`.
contract PaidEmitter {
    event Paid(
        bytes32 indexed invoiceId, address indexed payer, address indexed merchant, address tokenOut, uint256 amountOut
    );

    function emitPaid(bytes32 invoiceId, address payer, address merchant, address tokenOut, uint256 amountOut) external {
        emit Paid(invoiceId, payer, merchant, tokenOut, amountOut);
    }
}
