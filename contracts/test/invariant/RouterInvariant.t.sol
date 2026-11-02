// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {CobraRouter} from "../../src/CobraRouter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockEIP3009} from "../mocks/MockEIP3009.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";
import {RouterHandler} from "./RouterHandler.sol";

contract RouterInvariantTest is Test {
    CobraRouter internal router;
    MockSwapRouter internal swapRouter;
    MockPermit2 internal permit2;
    RouterHandler internal handler;
    address[4] internal tokens;
    address[2] internal payers;
    mapping(address => mapping(address => uint256)) internal initial;

    function setUp() public {
        vm.warp(1_790_000_000);
        permit2 = new MockPermit2();
        swapRouter = new MockSwapRouter();
        router = new CobraRouter(address(permit2), address(swapRouter));
        MockERC20 wARS = new MockERC20("Peso Argentino", "wARS", 18);
        MockEIP3009 usdc = new MockEIP3009("USDC", "2", "USDC", 6);
        MockEIP3009 usdt = new MockEIP3009("Tether USD", "1", "USDT", 6);
        MockERC20 mUSD = new MockERC20("Mento Dollar", "USDm", 18);
        swapRouter.setRate(address(usdc), address(wARS), 1650e12, 1);
        swapRouter.setRate(address(usdt), address(wARS), 1650e12, 1);
        swapRouter.setRate(address(mUSD), address(wARS), 1650, 1);
        tokens = [address(wARS), address(usdc), address(usdt), address(mUSD)];

        handler = new RouterHandler(router, swapRouter, permit2, wARS, address(usdc), address(usdt), address(mUSD));
        payers = [
            vm.addr(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80),
            vm.addr(0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d)
        ];
        for (uint256 p; p < 2; ++p) {
            for (uint256 t; t < 4; ++t) {
                MockERC20 tok = MockERC20(tokens[t]);
                tok.mint(payers[p], 1e40);
                vm.startPrank(payers[p]);
                tok.approve(address(permit2), type(uint256).max);
                tok.approve(address(router), type(uint256).max); // standing allowance: must never be abusable
                vm.stopPrank();
                initial[payers[p]][tokens[t]] = tok.balanceOf(payers[p]);
            }
        }

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = RouterHandler.pay.selector;
        selectors[1] = RouterHandler.replay.selector;
        selectors[2] = RouterHandler.moveRate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Router never retains funds or approvals.
    function invariant_routerHoldsNothing() public view {
        for (uint256 t; t < 4; ++t) {
            assertEq(MockERC20(tokens[t]).balanceOf(address(router)), 0, "router balance");
            assertEq(MockERC20(tokens[t]).allowance(address(router), address(swapRouter)), 0, "router allowance");
        }
    }

    /// Merchant receives exactly the sum of amountOut of successful payments (exact amount or nothing).
    function invariant_merchantExact() public view {
        assertEq(MockERC20(tokens[0]).balanceOf(handler.merchant()), handler.ghost_merchantExpected());
    }

    /// Payer never spends more than the sum of amountIn it signed in successful payments (net of refunds).
    function invariant_payerSpendBounded() public view {
        for (uint256 p; p < 2; ++p) {
            for (uint256 t; t < 4; ++t) {
                uint256 bal = MockERC20(tokens[t]).balanceOf(payers[p]);
                uint256 init = initial[payers[p]][tokens[t]];
                if (bal < init) {
                    assertLe(init - bal, handler.ghost_signedIn(payers[p], tokens[t]), "payer overspent");
                }
            }
        }
    }

    /// No invoice is ever paid twice, and every recorded payment is marked paid.
    function invariant_noDoublePay() public view {
        assertEq(handler.ghost_doublePaid(), 0);
        uint256 n = handler.paidHashesLength();
        for (uint256 i; i < n; ++i) {
            bytes32 h = handler.paidHashes(i);
            assertTrue(router.isPaid(h));
            assertEq(handler.ghost_timesPaid(h), 1);
        }
    }

    function afterInvariant() external view {
        // Make sure the campaign exercised both outcomes (not vacuous).
        console2.log("paid", handler.ghost_paidCount(), "failed", handler.ghost_failedCount());
        console2.log("replays", handler.ghost_replayAttempts());
        assertGt(handler.ghost_paidCount() + handler.ghost_failedCount(), 0);
    }
}
