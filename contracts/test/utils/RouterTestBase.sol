// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICobraRouter} from "../../src/ICobraRouter.sol";
import {CobraRouter} from "../../src/CobraRouter.sol";
import {SigUtils} from "./SigUtils.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockEIP3009} from "../mocks/MockEIP3009.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";

/// @notice Mock world: wARS (tokenOut, 18 dec), USDC & USDT (EIP-3009, 6 dec), mUSD (plain 18 dec, Permit2 only).
///         Rates: 1 USDC/USDT = 1650 wARS, 1 mUSD = 1650 wARS.
abstract contract RouterTestBase is SigUtils {
    CobraRouter internal router;
    MockPermit2 internal permit2;
    MockSwapRouter internal swapRouter;

    MockERC20 internal wARS;
    MockEIP3009 internal usdc;
    MockEIP3009 internal usdt;
    MockERC20 internal mUSD;

    address internal payer;
    address internal merchant = makeAddr("merchant");
    address internal relayer = makeAddr("relayer");

    uint24 internal constant FEE = 100;
    uint256 internal constant DEADLINE_IN = 1 hours;

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        payer = vm.addr(PAYER_PK);

        permit2 = new MockPermit2();
        swapRouter = new MockSwapRouter();
        router = new CobraRouter(address(permit2), address(swapRouter));

        wARS = new MockERC20("Peso Argentino", "wARS", 18);
        usdc = new MockEIP3009("USDC", "2", "USDC", 6);
        usdt = new MockEIP3009("Tether USD", "1", "USD\xe2\x82\xae", 6);
        mUSD = new MockERC20("Mento Dollar", "USDm", 18);

        swapRouter.setRate(address(usdc), address(wARS), 1650e12, 1);
        swapRouter.setRate(address(usdt), address(wARS), 1650e12, 1);
        swapRouter.setRate(address(mUSD), address(wARS), 1650, 1);

        _fund(payer);
    }

    function _fund(address who) internal {
        wARS.mint(who, 10_000_000e18);
        usdc.mint(who, 100_000e6);
        usdt.mint(who, 100_000e6);
        mUSD.mint(who, 100_000e18);
        vm.startPrank(who);
        wARS.approve(address(permit2), type(uint256).max);
        usdc.approve(address(permit2), type(uint256).max);
        usdt.approve(address(permit2), type(uint256).max);
        mUSD.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
    }

    function _invoice(uint256 amountOut) internal view returns (ICobraRouter.Invoice memory) {
        return ICobraRouter.Invoice({
            id: keccak256(abi.encode("invoice", amountOut, block.timestamp)),
            merchant: merchant,
            tokenOut: address(wARS),
            amountOut: amountOut,
            deadline: block.timestamp + DEADLINE_IN
        });
    }

    function _usdcLeg(uint256 amountIn) internal view returns (ICobraRouter.Leg memory) {
        return _leg(address(usdc), amountIn, ICobraRouter.PullKind.EIP3009, _path(address(usdc), FEE, address(wARS)));
    }

    function _usdtLeg(uint256 amountIn, ICobraRouter.PullKind kind) internal view returns (ICobraRouter.Leg memory) {
        return _leg(address(usdt), amountIn, kind, _path(address(usdt), FEE, address(wARS)));
    }

    function _directLeg(uint256 amountIn, ICobraRouter.PullKind kind) internal view returns (ICobraRouter.Leg memory) {
        return _leg(address(wARS), amountIn, kind, "");
    }

    function _signed(ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs)
        internal
        view
        returns (ICobraRouter.Leg[] memory)
    {
        _sign(router, PAYER_PK, inv, legs);
        return legs;
    }

    function _payAsRelayer(ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs) internal {
        vm.prank(relayer);
        router.pay(inv, payer, legs);
    }

    function _assertRouterEmpty() internal view {
        assertEq(wARS.balanceOf(address(router)), 0, "router wARS");
        assertEq(usdc.balanceOf(address(router)), 0, "router USDC");
        assertEq(usdt.balanceOf(address(router)), 0, "router USDT");
        assertEq(mUSD.balanceOf(address(router)), 0, "router mUSD");
        assertEq(usdc.allowance(address(router), address(swapRouter)), 0, "allowance USDC");
        assertEq(usdt.allowance(address(router), address(swapRouter)), 0, "allowance USDT");
        assertEq(mUSD.allowance(address(router), address(swapRouter)), 0, "allowance mUSD");
    }
}
