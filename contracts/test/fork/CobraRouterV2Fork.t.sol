// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICobraRouter} from "../../src/ICobraRouter.sol";
import {CobraRouterV2} from "../../src/CobraRouterV2.sol";
import {TextileSigUtils, IPermit2Domain} from "../utils/TextileSigUtils.sol";
import {LimitOrder} from "../vendor/textile-uniswapx/uniswapx/lib/LimitOrderLib.sol";
import {SignedOrder} from "../vendor/textile-uniswapx/uniswapx/base/ReactorStructs.sol";
import {IValidationCallback} from "../vendor/textile-uniswapx/uniswapx/interfaces/IValidationCallback.sol";

interface IERC20F {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function symbol() external view returns (string memory);
}

interface ITextileReactor {
    function permit2() external view returns (address);
    function feeController() external view returns (address);
}

interface IFeeController {
    function FEE_BPS() external view returns (uint256);
    function feeRecipient() external view returns (address);
}

interface IQuoterV2F {
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256 gasEstimate);
}

/// @notice Celo mainnet fork: CobraRouterV2 against the REAL Textile LimitOrderReactor, its live fee controller and
///         PreferredFillerValidation, the real Permit2, USD₮ and wBRL. No Textile quote is available offline, so a
///         forge test key plays the maker: it gets wBRL with `deal`, approves the real Permit2 and signs a LimitOrder
///         for the real reactor, taker = the v2 router. Skipped if the RPC is unreachable. Read-only: nothing is sent.
contract CobraRouterV2ForkTest is TextileSigUtils {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant SWAP_ROUTER02 = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;
    address internal constant QUOTER_V2 = 0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8;
    address internal constant REACTOR = 0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3;
    address internal constant FEE_CONTROLLER = 0x7b005466F905DD882A959888154587fA76cd3Ea7;
    address internal constant PREFERRED_FILLER = 0x10B9EbA3a175Df418a35CB8329a527691EE258C5;
    address internal constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address internal constant WBRL = 0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0;
    bytes32 internal constant PERMIT2_DOMAIN = 0xec832d34f61a0ea7e5bcde106cdda913dd6fcf3f2c65b6bf7e25f70afed47d0a;

    uint256 internal constant BUY = 540e18; // wBRL to merchant
    uint256 internal constant OUT = 100e6; // USD₮ to maker

    bool internal forked;
    CobraRouterV2 internal router;
    address internal payer;
    address internal maker;
    address internal feeRecipient;
    uint256 internal feeBps;
    uint256 internal nonce = uint256(keccak256("cobra-ws12-fork-maker"));
    address internal merchant = makeAddr("fork-merchant-v2");
    address internal relayer = makeAddr("fork-relayer-v2");

    function setUp() public {
        string memory rpc = vm.envOr("CELO_RPC_URL", string("https://forno.celo.org"));
        try vm.createSelectFork(rpc) {
            forked = block.chainid == 42220;
        } catch {
            forked = false;
        }
        if (!forked) return;

        // Re-check every address against the chain (docs/research/onchain-verification.md rule).
        assertGt(REACTOR.code.length, 0, "reactor code");
        assertEq(ITextileReactor(REACTOR).permit2(), PERMIT2, "reactor permit2");
        assertEq(IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR(), PERMIT2_DOMAIN, "permit2 domain");
        assertEq(ITextileReactor(REACTOR).feeController(), FEE_CONTROLLER, "fee controller moved: re-review");
        feeBps = IFeeController(FEE_CONTROLLER).FEE_BPS();
        feeRecipient = IFeeController(FEE_CONTROLLER).feeRecipient();
        assertLe(feeBps, 5, "fee bps above UniswapX MAX_FEE_BPS");
        assertGt(PREFERRED_FILLER.code.length, 0, "validation code");
        assertEq(IERC20F(USDT).symbol(), unicode"USD₮");
        assertEq(IERC20F(WBRL).symbol(), "wBRL");

        router = new CobraRouterV2(PERMIT2, SWAP_ROUTER02, REACTOR);
        payer = vm.addr(PAYER_PK);
        maker = vm.addr(MAKER_PK);
        // Public anvil keys may carry EIP-7702 delegations on Celo mainnet (SECURITY.md): clear in the LOCAL fork only.
        if (payer.code.length != 0) vm.etch(payer, "");
        if (maker.code.length != 0) vm.etch(maker, "");

        deal(USDT, payer, 1_000e6);
        vm.prank(payer);
        IERC20F(USDT).approve(PERMIT2, type(uint256).max);
        deal(WBRL, maker, 10_000e18);
        assertEq(IERC20F(WBRL).balanceOf(maker), 10_000e18, "deal wBRL");
        vm.prank(maker);
        IERC20F(WBRL).approve(PERMIT2, type(uint256).max);
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _order(uint256 buy, uint256 out) internal returns (LimitOrder memory) {
        return _limitOrder(REACTOR, maker, ++nonce, block.timestamp + 120, WBRL, buy, USDT, out);
    }

    function _signedLeg(LimitOrder memory o, uint256 amountIn, ICobraRouter.PullKind kind)
        internal
        view
        returns (ICobraRouter.Leg memory)
    {
        return _leg(USDT, amountIn, kind, _textilePath(_signOrder(MAKER_PK, PERMIT2, o)));
    }

    function _invoice(uint256 amountOut) internal view returns (ICobraRouter.Invoice memory) {
        return ICobraRouter.Invoice({
            id: keccak256(abi.encode("fork-v2", amountOut, nonce)),
            merchant: merchant,
            tokenOut: WBRL,
            amountOut: amountOut,
            deadline: block.timestamp + 30 minutes
        });
    }

    function _pay(ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs, string memory gasLabel) internal {
        _sign(router, PAYER_PK, inv, legs);
        vm.prank(relayer);
        uint256 g = gasleft();
        router.pay(inv, payer, legs);
        if (bytes(gasLabel).length != 0) emit log_named_uint(gasLabel, g - gasleft());
    }

    function _assertRouterEmpty() internal view {
        address r = address(router);
        assertEq(IERC20F(USDT).balanceOf(r), 0, "router USDT");
        assertEq(IERC20F(WBRL).balanceOf(r), 0, "router wBRL");
        assertEq(r.balance, 0, "router native");
        assertEq(IERC20F(USDT).allowance(r, REACTOR), 0, "allowance USDT->reactor");
        assertEq(IERC20F(WBRL).allowance(r, REACTOR), 0, "allowance wBRL->reactor");
        assertEq(IERC20F(USDT).allowance(r, SWAP_ROUTER02), 0, "allowance USDT->swap");
    }

    // ───────────────────────────── real reactor ─────────────────────────────

    function test_fork_textile_eip3009_usdtToWbrl_exactOutput() public onlyFork {
        uint256 amountIn = _withFee(OUT, feeBps);
        uint256 feeBefore = IERC20F(USDT).balanceOf(feeRecipient);
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        _pay(
            inv,
            _legs1(_signedLeg(_order(BUY, OUT), amountIn, ICobraRouter.PullKind.EIP3009)),
            "gas: fork pay, 1 Textile leg (EIP-3009)"
        );

        assertEq(IERC20F(WBRL).balanceOf(merchant), BUY, "merchant exact");
        assertEq(IERC20F(USDT).balanceOf(payer), 1_000e6 - amountIn, "payer");
        assertEq(IERC20F(USDT).balanceOf(maker), OUT, "maker");
        assertEq(IERC20F(USDT).balanceOf(feeRecipient) - feeBefore, OUT * feeBps / 10_000, "protocol fee");
        assertEq(IERC20F(WBRL).balanceOf(maker), 10_000e18 - BUY);
        assertTrue(router.isPaid(router.hashInvoice(inv)));
        _assertRouterEmpty();
    }

    function test_fork_textile_permit2_withBuffer_refunded() public onlyFork {
        uint256 amountIn = _withFee(OUT, feeBps) + 2e6;
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        _pay(
            inv,
            _legs1(_signedLeg(_order(BUY, OUT), amountIn, ICobraRouter.PullKind.PERMIT2)),
            "gas: fork pay, 1 Textile leg (Permit2)"
        );
        assertEq(IERC20F(WBRL).balanceOf(merchant), BUY);
        assertEq(IERC20F(USDT).balanceOf(payer), 1_000e6 - _withFee(OUT, feeBps), "buffer refunded");
        _assertRouterEmpty();
    }

    function test_fork_textile_preferredFiller_router_ok() public onlyFork {
        LimitOrder memory o = _order(BUY, OUT);
        _restrict(o, address(router));
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        _pay(
            inv,
            _legs1(_signedLeg(o, _withFee(OUT, feeBps), ICobraRouter.PullKind.EIP3009)),
            "gas: fork pay, 1 Textile leg + PreferredFillerValidation"
        );
        assertEq(IERC20F(WBRL).balanceOf(merchant), BUY);
        _assertRouterEmpty();
    }

    function test_fork_textile_preferredFiller_otherTaker_reverts() public onlyFork {
        LimitOrder memory o = _order(BUY, OUT);
        address other = makeAddr("another-taker");
        _restrict(o, other);
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _legs1(_signedLeg(o, _withFee(OUT, feeBps), ICobraRouter.PullKind.EIP3009));
        _sign(router, PAYER_PK, inv, legs);
        vm.expectRevert(
            abi.encodeWithSignature("FillerNotPreferred(address,uint256)", address(router), block.timestamp + 120)
        );
        vm.prank(relayer);
        router.pay(inv, payer, legs);
        assertEq(IERC20F(USDT).balanceOf(payer), 1_000e6);
    }

    function test_fork_textile_expiredQuote_reverts() public onlyFork {
        LimitOrder memory o = _order(BUY, OUT);
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _legs1(_signedLeg(o, _withFee(OUT, feeBps), ICobraRouter.PullKind.EIP3009));
        _sign(router, PAYER_PK, inv, legs);
        vm.warp(o.info.deadline + 1);
        vm.expectRevert(abi.encodeWithSignature("SignatureExpired(uint256)", o.info.deadline));
        vm.prank(relayer);
        router.pay(inv, payer, legs);
    }

    function test_fork_textile_missingFee_reverts() public onlyFork {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _legs1(_signedLeg(_order(BUY, OUT), OUT, ICobraRouter.PullKind.EIP3009));
        _sign(router, PAYER_PK, inv, legs);
        vm.expectRevert(bytes("TRANSFER_FROM_FAILED"));
        vm.prank(relayer);
        router.pay(inv, payer, legs);
        assertEq(IERC20F(USDT).balanceOf(payer), 1_000e6);
    }

    function test_fork_textile_tamperedOrder_realUsdtRejects() public onlyFork {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs =
            _legs1(_signedLeg(_order(BUY, OUT), _withFee(OUT, feeBps), ICobraRouter.PullKind.EIP3009));
        _sign(router, PAYER_PK, inv, legs);
        legs[0].path = _textilePath(_signOrder(MAKER_PK, PERMIT2, _order(BUY, OUT + 1e6)));
        vm.expectRevert(bytes("TetherToken: invalid signature"));
        vm.prank(relayer);
        router.pay(inv, payer, legs);
    }

    function test_fork_textile_plus_uniswap_mixed() public onlyFork {
        bytes memory upath = abi.encodePacked(USDT, uint24(100), WBRL);
        (uint256 uq,,,) = IQuoterV2F(QUOTER_V2).quoteExactInput(upath, 5e6);
        ICobraRouter.Invoice memory inv = _invoice(BUY + uq);
        ICobraRouter.Leg[] memory legs = _legs2(
            _signedLeg(_order(BUY, OUT), _withFee(OUT, feeBps), ICobraRouter.PullKind.EIP3009),
            _leg(USDT, 5e6, ICobraRouter.PullKind.PERMIT2, upath)
        );
        _pay(inv, legs, "gas: fork pay, Textile leg + Uniswap leg");
        assertEq(IERC20F(WBRL).balanceOf(merchant), BUY + uq);
        _assertRouterEmpty();
    }

    /// wCOP has no Uniswap V3 pool on Celo (docs/research/onchain-verification.md); Textile is its only venue.
    function test_fork_textile_usdtToWcop_noUniswapPool() public onlyFork {
        address wcop = 0x8a1D45e102e886510e891d2Ec656a708991e2D76;
        assertEq(IERC20F(wcop).symbol(), "wCOP");
        deal(wcop, maker, 1_000_000e18);
        vm.prank(maker);
        IERC20F(wcop).approve(PERMIT2, type(uint256).max);
        uint256 buy = 390_000e18; // ~100 USD₮
        LimitOrder memory o = _limitOrder(REACTOR, maker, ++nonce, block.timestamp + 120, wcop, buy, USDT, OUT);
        ICobraRouter.Invoice memory inv = _invoice(buy);
        inv.tokenOut = wcop;
        _pay(
            inv,
            _legs1(_signedLeg(o, _withFee(OUT, feeBps), ICobraRouter.PullKind.EIP3009)),
            "gas: fork pay, 1 Textile leg USDT->wCOP"
        );
        assertEq(IERC20F(wcop).balanceOf(merchant), buy, "merchant exact wCOP");
        assertEq(IERC20F(wcop).balanceOf(address(router)), 0);
        _assertRouterEmpty();
    }

    function test_fork_textile_nativeDustInReactor_forwarded() public onlyFork {
        vm.deal(REACTOR, 1 ether); // stray CELO in the real reactor: BaseReactor._fill refunds it to the filler
        uint256 before = payer.balance;
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        _pay(inv, _legs1(_signedLeg(_order(BUY, OUT), _withFee(OUT, feeBps), ICobraRouter.PullKind.EIP3009)), "");
        assertEq(payer.balance - before, 1 ether);
        assertEq(REACTOR.balance, 0);
        assertEq(IERC20F(WBRL).balanceOf(merchant), BUY);
        _assertRouterEmpty();
    }

    function test_fork_v1RouterWouldRevertOnNativeRefund_documented() public onlyFork {
        // Why v2 has a guarded receive: a filler without one is DoSed by 1 wei left in the reactor.
        vm.deal(REACTOR, 1);
        NoReceiveFiller f = new NoReceiveFiller();
        deal(USDT, address(f), _withFee(OUT, feeBps));
        LimitOrder memory o = _order(BUY, OUT);
        SignedOrder memory s = _signOrder(MAKER_PK, PERMIT2, o);
        vm.expectRevert(abi.encodeWithSignature("NativeTransferFailed()"));
        f.fill(REACTOR, USDT, _withFee(OUT, feeBps), s);
    }

    function _restrict(LimitOrder memory o, address filler) internal view {
        address[] memory fillers = new address[](1);
        fillers[0] = filler;
        o.info.additionalValidationContract = IValidationCallback(PREFERRED_FILLER);
        o.info.additionalValidationData = abi.encode(fillers, block.timestamp + 120);
    }
}

/// @dev Minimal filler without `receive` (like any contract that does not expect native).
contract NoReceiveFiller {
    function fill(address reactor, address token, uint256 amount, SignedOrder calldata s) external {
        IERC20F(token).approve(reactor, amount);
        SignedOrder[] memory orders = new SignedOrder[](1);
        orders[0] = s;
        (bool ok, bytes memory ret) =
            reactor.call(abi.encodeWithSignature("executeBatchWithCallback((bytes,bytes)[],bytes)", orders, bytes("")));
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    /// @dev Swallows the reactor's reactorCallback call; non-payable, so the native refund still fails.
    fallback() external {}
}
