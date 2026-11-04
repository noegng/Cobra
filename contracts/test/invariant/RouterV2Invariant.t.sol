// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {CobraRouterV2} from "../../src/CobraRouterV2.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockEIP3009} from "../mocks/MockEIP3009.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";
import {MockFeeController} from "../mocks/MockFeeController.sol";
import {LimitOrderReactor} from "../vendor/textile-uniswapx/uniswapx/reactors/LimitOrderReactor.sol";
import {IPermit2} from "../vendor/textile-uniswapx/permit2/src/interfaces/IPermit2.sol";
import {RouterV2Handler} from "./RouterV2Handler.sol";

contract RouterV2InvariantTest is Test {
    CobraRouterV2 internal router;
    LimitOrderReactor internal reactor;
    MockSwapRouter internal swapRouter;
    RouterV2Handler internal handler;
    MockERC20 internal wBRL;
    MockEIP3009 internal usdt;
    MockERC20 internal usdc;
    address internal payer = vm.addr(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80);
    uint256 internal usdtStart;
    uint256 internal usdcStart;

    function setUp() public {
        vm.warp(1_790_000_000);
        MockPermit2 permit2 = new MockPermit2();
        swapRouter = new MockSwapRouter();
        reactor = new LimitOrderReactor(IPermit2(address(permit2)), address(this));
        reactor.setProtocolFeeController(address(new MockFeeController(makeAddr("fee"), 1)));
        router = new CobraRouterV2(address(permit2), address(swapRouter), address(reactor));
        wBRL = new MockERC20("Real", "wBRL", 18);
        usdt = new MockEIP3009("Tether USD", "1", "USDT", 6);
        usdc = new MockERC20("USDC", "USDC", 6);
        swapRouter.setRate(address(usdc), address(wBRL), 53e11, 1);

        handler = new RouterV2Handler(router, address(reactor), address(permit2), swapRouter, wBRL, usdt, usdc);

        address[3] memory toks = [address(wBRL), address(usdt), address(usdc)];
        for (uint256 t; t < 3; ++t) {
            MockERC20(toks[t]).mint(payer, 1e40);
            vm.startPrank(payer);
            MockERC20(toks[t]).approve(address(permit2), type(uint256).max);
            MockERC20(toks[t]).approve(address(router), type(uint256).max); // standing allowance: never abusable
            vm.stopPrank();
        }
        address[2] memory makers = [
            vm.addr(0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a),
            vm.addr(0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6)
        ];
        for (uint256 m; m < 2; ++m) {
            wBRL.mint(makers[m], 1e40);
            vm.prank(makers[m]);
            wBRL.approve(address(permit2), type(uint256).max);
        }
        usdtStart = usdt.balanceOf(payer);
        usdcStart = usdc.balanceOf(payer);

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = RouterV2Handler.pay.selector;
        selectors[1] = RouterV2Handler.pay.selector; // weight
        selectors[2] = RouterV2Handler.dustReactor.selector;
        selectors[3] = RouterV2Handler.replay.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Router never ends a transaction holding tokens, native coin or an allowance.
    function invariant_v2_routerHoldsNothing() public view {
        address r = address(router);
        assertEq(wBRL.balanceOf(r), 0, "wBRL");
        assertEq(usdt.balanceOf(r), 0, "USDT");
        assertEq(usdc.balanceOf(r), 0, "USDC");
        assertEq(r.balance, 0, "native");
        assertEq(usdt.allowance(r, address(reactor)), 0, "USDT->reactor");
        assertEq(usdc.allowance(r, address(reactor)), 0, "USDC->reactor");
        assertEq(wBRL.allowance(r, address(reactor)), 0, "wBRL->reactor");
        assertEq(usdt.allowance(r, address(swapRouter)), 0, "USDT->swap");
        assertEq(usdc.allowance(r, address(swapRouter)), 0, "USDC->swap");
    }

    /// Merchant receives exactly the sum of paid invoices, never more, never less.
    function invariant_v2_merchantExact() public view {
        assertEq(wBRL.balanceOf(handler.merchant()), handler.ghost_merchantExpected());
    }

    function invariant_v2_noDoublePay() public view {
        assertEq(handler.ghost_doublePaid(), 0);
    }

    /// Payer never spends more of a leg token than it signed across successful payments.
    function invariant_v2_payerSpendBounded() public view {
        assertLe(usdtStart - usdt.balanceOf(payer), handler.ghost_signedIn(address(usdt)), "USDT");
        assertLe(usdcStart - usdc.balanceOf(payer), handler.ghost_signedIn(address(usdc)), "USDC");
    }

    /// Native dust left in the reactor never sticks in the router (payer is an EOA here).
    function invariant_v2_nativeDustNotRetained() public view {
        assertEq(address(router).balance, 0);
        assertLe(payer.balance, handler.ghost_nativeDust());
    }

    /// Coverage guard: the campaign must actually settle Textile payments, not only revert.
    function afterInvariant() public view {
        console2.log("paid", handler.ghost_paidCount(), "failed", handler.ghost_failedCount());
        console2.log("textile paid", handler.ghost_textilePaid(), "native dust", handler.ghost_nativeDust());
    }
}
