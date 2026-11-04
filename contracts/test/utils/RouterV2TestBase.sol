// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICobraRouter} from "../../src/ICobraRouter.sol";
import {CobraRouterV2} from "../../src/CobraRouterV2.sol";
import {TextileSigUtils} from "./TextileSigUtils.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockEIP3009} from "../mocks/MockEIP3009.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";
import {MockFeeController} from "../mocks/MockFeeController.sol";
import {LimitOrderReactor} from "../vendor/textile-uniswapx/uniswapx/reactors/LimitOrderReactor.sol";
import {IPermit2} from "../vendor/textile-uniswapx/permit2/src/interfaces/IPermit2.sol";
import {LimitOrder} from "../vendor/textile-uniswapx/uniswapx/lib/LimitOrderLib.sol";
import {SignedOrder} from "../vendor/textile-uniswapx/uniswapx/base/ReactorStructs.sol";

/// @notice v2 mock world: the verified Textile/UniswapX LimitOrderReactor source (test/vendor) on top of the faithful
///         MockPermit2, with a 1 bps output fee controller (Celo's on-chain FEE_BPS). Tokens: wBRL (tokenOut,
///         18 dec), USD₮ and USDC (EIP-3009, 6 dec). Textile price 1 USD₮ = 5.40 wBRL; Uniswap mock 1 USDC = 5.30 wBRL.
abstract contract RouterV2TestBase is TextileSigUtils {
    CobraRouterV2 internal router;
    MockPermit2 internal permit2;
    MockSwapRouter internal swapRouter;
    LimitOrderReactor internal reactor;
    MockFeeController internal feeController;

    MockERC20 internal wBRL;
    MockEIP3009 internal usdt;
    MockEIP3009 internal usdc;

    address internal payer;
    address internal maker;
    address internal maker2;
    address internal merchant = makeAddr("merchant");
    address internal relayer = makeAddr("relayer");
    address internal feeRecipient = makeAddr("textile-fee");

    uint256 internal constant FEE_BPS = 1;
    uint24 internal constant FEE = 100;
    uint256 internal constant QUOTE_TTL = 120;
    uint256 internal makerNonce;

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        payer = vm.addr(PAYER_PK);
        maker = vm.addr(MAKER_PK);
        maker2 = vm.addr(MAKER2_PK);

        permit2 = new MockPermit2();
        swapRouter = new MockSwapRouter();
        reactor = new LimitOrderReactor(IPermit2(address(permit2)), address(this));
        feeController = new MockFeeController(feeRecipient, FEE_BPS);
        reactor.setProtocolFeeController(address(feeController));
        router = new CobraRouterV2(address(permit2), address(swapRouter), address(reactor));

        wBRL = new MockERC20("Real Brasileiro", "wBRL", 18);
        usdt = new MockEIP3009("Tether USD", "1", "USD\xe2\x82\xae", 6);
        usdc = new MockEIP3009("USDC", "2", "USDC", 6);
        swapRouter.setRate(address(usdc), address(wBRL), 53e11, 1);

        _fundPayer(payer);
        _fundMaker(maker);
        _fundMaker(maker2);
    }

    function _fundPayer(address who) internal {
        wBRL.mint(who, 100_000e18);
        usdt.mint(who, 100_000e6);
        usdc.mint(who, 100_000e6);
        vm.startPrank(who);
        wBRL.approve(address(permit2), type(uint256).max);
        usdt.approve(address(permit2), type(uint256).max);
        usdc.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
    }

    function _fundMaker(address who) internal {
        wBRL.mint(who, 1_000_000e18);
        vm.prank(who);
        wBRL.approve(address(permit2), type(uint256).max);
    }

    function _invoice(uint256 amountOut) internal view returns (ICobraRouter.Invoice memory) {
        return ICobraRouter.Invoice({
            id: keccak256(abi.encode("invoice-v2", amountOut, block.timestamp)),
            merchant: merchant,
            tokenOut: address(wBRL),
            amountOut: amountOut,
            deadline: block.timestamp + 1 hours
        });
    }

    /// @dev Textile exact-output quote: maker sells `buyAmount` wBRL for `usdtOut` USD₮ (to the maker).
    function _quoteOrder(uint256 pk, uint256 buyAmount, uint256 usdtOut) internal returns (LimitOrder memory) {
        return _limitOrder(
            address(reactor),
            vm.addr(pk),
            ++makerNonce,
            block.timestamp + QUOTE_TTL,
            address(wBRL),
            buyAmount,
            address(usdt),
            usdtOut
        );
    }

    function _signed(uint256 pk, LimitOrder memory o) internal view returns (SignedOrder memory) {
        return _signOrder(pk, address(permit2), o);
    }

    function _textileLeg(uint256 amountIn, ICobraRouter.PullKind kind, SignedOrder[] memory orders)
        internal
        view
        returns (ICobraRouter.Leg memory)
    {
        return _leg(address(usdt), amountIn, kind, _textilePath(orders));
    }

    /// @dev 1 maker order: `buyAmount` wBRL for `usdtOut` USD₮; leg pulls `amountIn` USD₮ via `kind`.
    function _oneOrderLeg(uint256 buyAmount, uint256 usdtOut, uint256 amountIn, ICobraRouter.PullKind kind)
        internal
        returns (ICobraRouter.Leg memory)
    {
        return _textileLeg(amountIn, kind, _orders1(_signed(MAKER_PK, _quoteOrder(MAKER_PK, buyAmount, usdtOut))));
    }

    function _sign(ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs)
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
        address r = address(router);
        assertEq(wBRL.balanceOf(r), 0, "router wBRL");
        assertEq(usdt.balanceOf(r), 0, "router USDT");
        assertEq(usdc.balanceOf(r), 0, "router USDC");
        assertEq(r.balance, 0, "router native");
        assertEq(usdt.allowance(r, address(reactor)), 0, "allowance USDT->reactor");
        assertEq(usdc.allowance(r, address(reactor)), 0, "allowance USDC->reactor");
        assertEq(wBRL.allowance(r, address(reactor)), 0, "allowance wBRL->reactor");
        assertEq(usdt.allowance(r, address(swapRouter)), 0, "allowance USDT->swap");
        assertEq(usdc.allowance(r, address(swapRouter)), 0, "allowance USDC->swap");
    }
}
