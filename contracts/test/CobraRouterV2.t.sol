// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICobraRouter} from "../src/ICobraRouter.sol";
import {CobraRouter} from "../src/CobraRouter.sol";
import {CobraRouterV2} from "../src/CobraRouterV2.sol";
import {IUniswapXReactor} from "../src/interfaces/IUniswapXReactor.sol";
import {RouterV2TestBase} from "./utils/RouterV2TestBase.sol";
import {MockFillerValidation} from "./mocks/MockFillerValidation.sol";
import {ReactorReentrantToken} from "./mocks/ReactorReentrantToken.sol";
import {LimitOrder} from "./vendor/textile-uniswapx/uniswapx/lib/LimitOrderLib.sol";
import {OutputToken, SignedOrder} from "./vendor/textile-uniswapx/uniswapx/base/ReactorStructs.sol";
import {IValidationCallback} from "./vendor/textile-uniswapx/uniswapx/interfaces/IValidationCallback.sol";
import {IReactor} from "./vendor/textile-uniswapx/uniswapx/interfaces/IReactor.sol";
import {ERC20} from "./vendor/textile-uniswapx/solmate/src/tokens/ERC20.sol";

/// @notice CobraRouterV2 unit tests: Textile venue against the vendored (verified-source) UniswapX
///         LimitOrderReactor with a 1 bps fee controller, plus v1 behaviour that must be unchanged.
contract CobraRouterV2Test is RouterV2TestBase {
    uint256 internal constant BUY = 540e18; // wBRL the maker sells (== invoice amountOut)
    uint256 internal constant OUT = 100e6; // USD₮ the maker asks
    uint256 internal constant IN = 100_010_000; // OUT + 1 bps protocol fee
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    ICobraRouter.PullKind internal constant EIP3009 = ICobraRouter.PullKind.EIP3009;
    ICobraRouter.PullKind internal constant PERMIT2 = ICobraRouter.PullKind.PERMIT2;
    ICobraRouter.PullKind internal constant ALLOWANCE = ICobraRouter.PullKind.ALLOWANCE;

    // ───────────────────────────── happy paths ─────────────────────────────

    function test_textile_happyPath_eip3009_exactOutput() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_oneOrderLeg(BUY, OUT, IN, EIP3009)));

        vm.expectEmit(true, true, true, true, address(router));
        emit ICobraRouter.Paid(inv.id, payer, merchant, address(wBRL), BUY);
        vm.prank(relayer);
        uint256 g = gasleft();
        router.pay(inv, payer, legs);
        emit log_named_uint("gas: pay, 1 Textile leg (EIP-3009 pull, mocks)", g - gasleft());

        assertEq(wBRL.balanceOf(merchant), BUY, "merchant exact");
        assertEq(usdt.balanceOf(payer), 100_000e6 - IN, "payer spent IN");
        assertEq(usdt.balanceOf(maker), OUT, "maker paid");
        assertEq(usdt.balanceOf(feeRecipient), IN - OUT, "1 bps fee");
        assertEq(wBRL.balanceOf(maker), 1_000_000e18 - BUY, "maker sold BUY");
        assertEq(wBRL.balanceOf(payer), 100_000e18, "no wBRL surplus");
        assertTrue(router.isPaid(router.hashInvoice(inv)));
        _assertRouterEmpty();
    }

    function test_textile_happyPath_permit2() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_oneOrderLeg(BUY, OUT, IN, PERMIT2)));
        vm.prank(relayer);
        uint256 g = gasleft();
        router.pay(inv, payer, legs);
        emit log_named_uint("gas: pay, 1 Textile leg (Permit2 pull, mocks)", g - gasleft());
        assertEq(wBRL.balanceOf(merchant), BUY);
        assertEq(usdt.balanceOf(payer), 100_000e6 - IN);
        _assertRouterEmpty();
    }

    function test_textile_payerIsSender_allowance() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_oneOrderLeg(BUY, OUT, IN, ALLOWANCE)));
        vm.startPrank(payer);
        usdt.approve(address(router), IN);
        router.pay(inv, payer, legs);
        vm.stopPrank();
        assertEq(wBRL.balanceOf(merchant), BUY);
        assertEq(usdt.allowance(payer, address(router)), 0);
        _assertRouterEmpty();
    }

    function test_textile_unconsumedInputRefunded() public {
        uint256 buffer = 5e6;
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_oneOrderLeg(BUY, OUT, IN + buffer, EIP3009)));
        _payAsRelayer(inv, legs);
        assertEq(wBRL.balanceOf(merchant), BUY);
        assertEq(usdt.balanceOf(payer), 100_000e6 - IN, "unspent USDT back to payer");
        assertEq(usdt.balanceOf(maker) + usdt.balanceOf(feeRecipient), IN);
        _assertRouterEmpty();
    }

    function test_textile_surplusTokenOutRefunded() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_oneOrderLeg(BUY + 3e18, OUT, IN, EIP3009)));
        _payAsRelayer(inv, legs);
        assertEq(wBRL.balanceOf(merchant), BUY);
        assertEq(wBRL.balanceOf(payer), 100_000e18 + 3e18, "surplus wBRL to payer");
        _assertRouterEmpty();
    }

    function test_textile_twoMakers_oneBatch() public {
        SignedOrder memory a = _signed(MAKER_PK, _quoteOrder(MAKER_PK, 300e18, 55e6));
        SignedOrder memory b = _signed(MAKER2_PK, _quoteOrder(MAKER2_PK, 240e18, 45e6));
        uint256 amountIn = _withFee(55e6, FEE_BPS) + _withFee(45e6, FEE_BPS);
        ICobraRouter.Invoice memory inv = _invoice(540e18);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_textileLeg(amountIn, EIP3009, _orders2(a, b))));
        _payAsRelayer(inv, legs);
        assertEq(wBRL.balanceOf(merchant), 540e18);
        assertEq(usdt.balanceOf(maker), 55e6);
        assertEq(usdt.balanceOf(maker2), 45e6);
        assertEq(usdt.balanceOf(payer), 100_000e6 - amountIn);
        _assertRouterEmpty();
    }

    function test_textile_fillerRestrictedToRouter_ok() public {
        LimitOrder memory o = _quoteOrder(MAKER_PK, BUY, OUT);
        _restrict(o, address(router));
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_textileLeg(IN, EIP3009, _orders1(_signed(MAKER_PK, o)))));
        _payAsRelayer(inv, legs);
        assertEq(wBRL.balanceOf(merchant), BUY);
        _assertRouterEmpty();
    }

    // ───────────────────────────── mixed legs ─────────────────────────────

    function test_mixed_textile_plus_direct() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY + 100e18);
        ICobraRouter.Leg[] memory legs = _sign(
            inv, _legs2(_oneOrderLeg(BUY, OUT, IN, EIP3009), _leg(address(wBRL), 100e18, PERMIT2, ""))
        );
        _payAsRelayer(inv, legs);
        assertEq(wBRL.balanceOf(merchant), BUY + 100e18);
        assertEq(wBRL.balanceOf(payer), 100_000e18 - 100e18);
        _assertRouterEmpty();
    }

    function test_mixed_threeVenues_textile_uniswap_direct() public {
        // Textile 540 + Uniswap 10 USDC -> 53 + direct 7 = 600 wBRL; payer sends (ALLOWANCE leg).
        ICobraRouter.Invoice memory inv = _invoice(600e18);
        ICobraRouter.Leg[] memory legs = _sign(
            inv,
            _legs3(
                _oneOrderLeg(BUY, OUT, IN, EIP3009),
                _leg(address(usdc), 10e6, PERMIT2, _path(address(usdc), FEE, address(wBRL))),
                _leg(address(wBRL), 7e18, ALLOWANCE, "")
            )
        );
        vm.startPrank(payer);
        wBRL.approve(address(router), 7e18);
        router.pay(inv, payer, legs);
        vm.stopPrank();
        assertEq(wBRL.balanceOf(merchant), 600e18);
        assertEq(usdc.balanceOf(payer), 100_000e6 - 10e6);
        assertEq(usdt.balanceOf(payer), 100_000e6 - IN);
        _assertRouterEmpty();
    }

    function test_mixed_twoTextileLegs_sameToken() public {
        ICobraRouter.Invoice memory inv = _invoice(540e18);
        ICobraRouter.Leg[] memory legs = _sign(
            inv,
            _legs2(
                _textileLeg(
                    _withFee(55e6, FEE_BPS), EIP3009, _orders1(_signed(MAKER_PK, _quoteOrder(MAKER_PK, 300e18, 55e6)))
                ),
                _textileLeg(
                    _withFee(45e6, FEE_BPS),
                    PERMIT2,
                    _orders1(_signed(MAKER2_PK, _quoteOrder(MAKER2_PK, 240e18, 45e6)))
                )
            )
        );
        _payAsRelayer(inv, legs);
        assertEq(wBRL.balanceOf(merchant), 540e18);
        _assertRouterEmpty();
    }

    function test_mixed_aggregateShortfall_reverts() public {
        // Textile 540 + direct 10 = 550 < 551
        ICobraRouter.Invoice memory inv = _invoice(551e18);
        ICobraRouter.Leg[] memory legs =
            _sign(inv, _legs2(_oneOrderLeg(BUY, OUT, IN, EIP3009), _leg(address(wBRL), 10e18, PERMIT2, "")));
        vm.expectRevert(abi.encodeWithSelector(ICobraRouter.InsufficientOutput.selector, 550e18, 551e18));
        _payAsRelayer(inv, legs);
    }

    // ───────────────────────────── order validation ─────────────────────────────

    function test_revert_textile_wrongInputToken() public {
        LimitOrder memory o = _quoteOrder(MAKER_PK, BUY, OUT);
        o.input.token = ERC20(address(usdc)); // maker sells USDC, invoice wants wBRL
        _expectInvalidOrder(_orders1(_signed(MAKER_PK, o)));
    }

    function test_revert_textile_wrongReactor() public {
        LimitOrder memory o = _quoteOrder(MAKER_PK, BUY, OUT);
        o.info.reactor = IReactor(makeAddr("other-reactor"));
        _expectInvalidOrder(_orders1(_signed(MAKER_PK, o)));
    }

    function test_revert_textile_outputWrongToken() public {
        LimitOrder memory o = _quoteOrder(MAKER_PK, BUY, OUT);
        o.outputs[0].token = address(usdc); // leg pulls USD₮
        _expectInvalidOrder(_orders1(_signed(MAKER_PK, o)));
    }

    function test_revert_textile_outputIsTokenOut() public {
        LimitOrder memory o = _quoteOrder(MAKER_PK, BUY, OUT);
        o.outputs[0].token = address(wBRL);
        _expectInvalidOrder(_orders1(_signed(MAKER_PK, o)));
    }

    function test_revert_textile_extraOutputToken() public {
        LimitOrder memory o = _quoteOrder(MAKER_PK, BUY, OUT);
        OutputToken[] memory outs = new OutputToken[](2);
        outs[0] = o.outputs[0];
        outs[1] = OutputToken({token: address(usdc), amount: 1e6, recipient: maker});
        o.outputs = outs;
        _expectInvalidOrder(_orders1(_signed(MAKER_PK, o)));
    }

    function test_revert_textile_secondOrderInvalid() public {
        LimitOrder memory bad = _quoteOrder(MAKER2_PK, 10e18, 2e6);
        bad.info.reactor = IReactor(makeAddr("other-reactor"));
        _expectInvalidOrder(
            _orders2(_signed(MAKER_PK, _quoteOrder(MAKER_PK, BUY, OUT)), _signed(MAKER2_PK, bad))
        );
    }

    function test_revert_textile_noOrders() public {
        _expectInvalidOrder(new SignedOrder[](0));
    }

    function test_revert_textile_malformedEncoding() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs =
            _sign(inv, _legs1(_leg(address(usdt), IN, EIP3009, abi.encodePacked(TXF1, hex"00ff"))));
        vm.expectRevert(); // ABI decoder revert, before any pull
        _payAsRelayer(inv, legs);
        assertEq(usdt.balanceOf(payer), 100_000e6);
    }

    function test_revert_textile_orderBytesNotALimitOrder() public {
        SignedOrder memory s = _signed(MAKER_PK, _quoteOrder(MAKER_PK, BUY, OUT));
        s.order = hex"deadbeef";
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_textileLeg(IN, EIP3009, _orders1(s))));
        vm.expectRevert();
        _payAsRelayer(inv, legs);
    }

    function test_revert_magicOnly_isTreatedAsUniswapPath() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_leg(address(usdt), IN, EIP3009, abi.encodePacked(TXF1))));
        vm.expectRevert(ICobraRouter.InvalidPath.selector);
        _payAsRelayer(inv, legs);
    }

    function test_revert_textilePath_onDirectLeg() public {
        SignedOrder[] memory orders = _orders1(_signed(MAKER_PK, _quoteOrder(MAKER_PK, BUY, OUT)));
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_leg(address(wBRL), BUY, PERMIT2, _textilePath(orders))));
        vm.expectRevert(ICobraRouter.InvalidPath.selector);
        _payAsRelayer(inv, legs);
    }

    // ───────────────────────────── reactor-side failures (fail closed) ─────────────────────────────

    function test_revert_textile_expiredOrder() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_oneOrderLeg(BUY, OUT, IN, EIP3009)));
        vm.warp(block.timestamp + QUOTE_TTL + 1); // invoice still valid, quote expired
        vm.expectRevert(bytes("SignatureExpired"));
        _payAsRelayer(inv, legs);
        assertEq(usdt.balanceOf(payer), 100_000e6);
        assertFalse(router.isPaid(router.hashInvoice(inv)));
    }

    function test_revert_textile_fillerRestrictedToOtherTaker() public {
        LimitOrder memory o = _quoteOrder(MAKER_PK, BUY, OUT);
        _restrict(o, makeAddr("other-taker"));
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_textileLeg(IN, EIP3009, _orders1(_signed(MAKER_PK, o)))));
        vm.expectRevert(bytes("FillerNotPreferred"));
        _payAsRelayer(inv, legs);
    }

    function test_revert_textile_amountInBelowOutputPlusFee() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_oneOrderLeg(BUY, OUT, OUT, EIP3009))); // fee missing
        vm.expectRevert(bytes("TRANSFER_FROM_FAILED"));
        _payAsRelayer(inv, legs);
        assertEq(usdt.balanceOf(payer), 100_000e6);
        assertEq(wBRL.balanceOf(maker), 1_000_000e18);
    }

    function test_revert_textile_makerUnderdelivers() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_oneOrderLeg(BUY - 1, OUT, IN, EIP3009)));
        vm.expectRevert(abi.encodeWithSelector(ICobraRouter.InsufficientOutput.selector, BUY - 1, BUY));
        _payAsRelayer(inv, legs);
    }

    function test_revert_textile_feeOnInputToken_failsClosed() public {
        // A fee on the maker's input token (wBRL) would be pulled from the router, which never approves tokenOut.
        feeController.setFeeOnInput(true);
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_oneOrderLeg(BUY, OUT, IN, EIP3009)));
        vm.expectRevert(bytes("TRANSFER_FROM_FAILED"));
        _payAsRelayer(inv, legs);
    }

    function test_revert_textile_makerOrderAlreadyFilled() public {
        SignedOrder memory s = _signed(MAKER_PK, _quoteOrder(MAKER_PK, BUY, OUT));
        ICobraRouter.Invoice memory inv1 = _invoice(BUY);
        _payAsRelayer(inv1, _sign(inv1, _legs1(_textileLeg(IN, EIP3009, _orders1(s)))));
        vm.warp(block.timestamp + 1);
        ICobraRouter.Invoice memory inv2 = _invoice(BUY); // different id
        ICobraRouter.Leg[] memory legs2 = _sign(inv2, _legs1(_textileLeg(IN, EIP3009, _orders1(s))));
        vm.expectRevert(bytes("InvalidNonce")); // Permit2 nonce of the maker already used
        _payAsRelayer(inv2, legs2);
    }

    // ───────────────────────────── callback / receive guards ─────────────────────────────

    function test_revert_callback_notReactor() public {
        vm.expectRevert(CobraRouterV2.UnauthorizedCallback.selector);
        router.reactorCallback(new IUniswapXReactor.ResolvedOrder[](0), "");
    }

    function test_revert_callback_reactorOutsidePay() public {
        vm.prank(address(reactor));
        vm.expectRevert(CobraRouterV2.UnauthorizedCallback.selector);
        router.reactorCallback(new IUniswapXReactor.ResolvedOrder[](0), "");
    }

    function test_revert_receive_outsideFill() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(router).call{value: 1}("");
        assertFalse(ok, "anyone");
        vm.deal(address(reactor), 1 ether);
        vm.prank(address(reactor));
        (ok,) = address(router).call{value: 1}("");
        assertFalse(ok, "reactor outside fill");
        assertEq(address(router).balance, 0);
    }

    function test_revert_noFallback() public {
        (bool ok,) = address(router).call(hex"12345678");
        assertFalse(ok);
    }

    function test_textile_nativeDustInReactor_forwardedToPayer() public {
        // BaseReactor._fill sends its whole native balance to the filler. Without `receive` this would DoS v2.
        vm.deal(address(reactor), 1 ether);
        uint256 payerNative = payer.balance;
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        _payAsRelayer(inv, _sign(inv, _legs1(_oneOrderLeg(BUY, OUT, IN, EIP3009))));
        assertEq(payer.balance, payerNative + 1 ether, "dust to payer");
        assertEq(address(reactor).balance, 0);
        assertEq(wBRL.balanceOf(merchant), BUY);
        _assertRouterEmpty();
    }

    function test_textile_nativeDust_payerRejects_paymentStillSucceeds() public {
        vm.deal(address(reactor), 1 ether);
        vm.etch(payer, hex"5f5ffd"); // payer code that reverts on any call (e.g. a contract wallet w/o receive)
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        _payAsRelayer(inv, _sign(inv, _legs1(_oneOrderLeg(BUY, OUT, IN, EIP3009))));
        assertEq(wBRL.balanceOf(merchant), BUY, "merchant paid");
        assertEq(address(router).balance, 1 ether, "dust stays (documented)");
    }

    // ───────────────────────────── reentrancy ─────────────────────────────

    function test_reentrancy_payFromInsideTextileFill_blocked() public {
        ReactorReentrantToken evil = _evilWorld();
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_evilLeg(evil, 1)));
        // inner: a second, validly signed payment
        ICobraRouter.Invoice memory inv2 = _invoice(BUY - 1);
        ICobraRouter.Leg[] memory legs2 = _sign(inv2, _legs1(_leg(address(wBRL), BUY - 1, PERMIT2, "")));
        evil.arm(address(reactor), address(router), abi.encodeCall(router.pay, (inv2, payer, legs2)));

        _payAsRelayer(inv, legs);
        assertTrue(evil.attempted());
        assertFalse(evil.innerSuccess());
        assertEq(evil.innerRevertData(), abi.encodeWithSignature("Error(string)", "REENTRANCY"));
        assertFalse(router.isPaid(router.hashInvoice(inv2)));
        assertEq(wBRL.balanceOf(merchant), BUY);
    }

    function test_reentrancy_callbackFromNonReactorDuringFill_blocked() public {
        ReactorReentrantToken evil = _evilWorld();
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_evilLeg(evil, 2)));
        evil.arm(
            address(reactor),
            address(router),
            abi.encodeCall(router.reactorCallback, (new IUniswapXReactor.ResolvedOrder[](0), bytes("")))
        );
        _payAsRelayer(inv, legs);
        assertTrue(evil.attempted());
        assertFalse(evil.innerSuccess());
        assertEq(evil.innerRevertData(), abi.encodeWithSelector(CobraRouterV2.UnauthorizedCallback.selector));
    }

    function test_reentrancy_reactorReentryDuringFill_blocked() public {
        ReactorReentrantToken evil = _evilWorld();
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_evilLeg(evil, 3)));
        SignedOrder[] memory none = new SignedOrder[](0);
        evil.arm(address(reactor), address(reactor), abi.encodeCall(reactor.executeBatchWithCallback, (none, bytes(""))));
        _payAsRelayer(inv, legs);
        assertTrue(evil.attempted());
        assertFalse(evil.innerSuccess()); // UniswapX reactor's own nonReentrant
        assertEq(evil.innerRevertData(), abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
    }

    // ───────────────────────────── signature binding ─────────────────────────────

    function test_tamper_swappedOrder_invalidatesPayerSignature() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_oneOrderLeg(BUY, OUT, IN, EIP3009)));
        // Relayer swaps in another, equally valid maker order (e.g. a worse price) after the payer signed.
        legs[0].path = _textilePath(_orders1(_signed(MAKER2_PK, _quoteOrder(MAKER2_PK, BUY, OUT + 1e6))));
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _payAsRelayer(inv, legs);

        // Same against the Permit2 pull: the witness no longer matches.
        ICobraRouter.Invoice memory inv2 = _invoice(BUY - 1);
        ICobraRouter.Leg[] memory l2 = _sign(inv2, _legs1(_oneOrderLeg(BUY - 1, OUT, IN, PERMIT2)));
        l2[0].path = _textilePath(_orders1(_signed(MAKER2_PK, _quoteOrder(MAKER2_PK, BUY - 1, OUT))));
        vm.expectRevert(bytes("InvalidSigner"));
        _payAsRelayer(inv2, l2);
    }

    function test_tamper_malleatedMakerSignature_invalidatesPayerSignature() public {
        SignedOrder memory s = _signed(MAKER_PK, _quoteOrder(MAKER_PK, BUY, OUT));
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_textileLeg(IN, EIP3009, _orders1(s))));
        // Same order, other (still ecrecover-valid) encoding of the maker signature: only the sig bytes change.
        (bytes32 r, bytes32 sv, uint8 v) = _split(s.sig);
        s.sig = abi.encodePacked(r, bytes32(N - uint256(sv)), v == 27 ? uint8(28) : uint8(27));
        legs[0].path = _textilePath(_orders1(s));
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _payAsRelayer(inv, legs);
    }

    function test_tamper_droppedOrder_invalidatesPayerSignature() public {
        SignedOrder memory a = _signed(MAKER_PK, _quoteOrder(MAKER_PK, 300e18, 55e6));
        SignedOrder memory b = _signed(MAKER2_PK, _quoteOrder(MAKER2_PK, 240e18, 45e6));
        ICobraRouter.Invoice memory inv = _invoice(300e18);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_textileLeg(IN, EIP3009, _orders2(a, b))));
        legs[0].path = _textilePath(_orders1(a)); // drop b: payer would overpay for 300 wBRL
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _payAsRelayer(inv, legs);
    }

    function test_revert_replay_alreadyPaid() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_oneOrderLeg(BUY, OUT, IN, EIP3009)));
        _payAsRelayer(inv, legs);
        vm.expectRevert(ICobraRouter.AlreadyPaid.selector);
        _payAsRelayer(inv, legs);
        vm.expectRevert(ICobraRouter.AlreadyPaid.selector);
        vm.prank(payer);
        router.pay(inv, payer, legs);
    }

    function test_crossRouter_v1SignatureRejectedByV2() public {
        CobraRouter v1 = new CobraRouter(address(permit2), address(swapRouter));
        ICobraRouter.Invoice memory inv = _invoice(100e18);
        ICobraRouter.Leg[] memory legs = _legs1(_leg(address(wBRL), 100e18, PERMIT2, ""));
        assertEq(v1.hashIntent(inv, payer, legs), router.hashIntent(inv, payer, legs), "same struct hash");
        assertTrue(v1.intentDigest(inv, payer, legs) != router.intentDigest(inv, payer, legs), "domain differs");
        _sign(v1, PAYER_PK, inv, legs); // signed for v1 (spender = v1)
        vm.expectRevert(bytes("InvalidSigner"));
        _payAsRelayer(inv, legs);
    }

    // ───────────────────────────── v1 behaviour unchanged ─────────────────────────────

    function test_uniswapLeg_sameAsV1() public {
        ICobraRouter.Invoice memory inv = _invoice(53e18);
        ICobraRouter.Leg[] memory legs =
            _sign(inv, _legs1(_leg(address(usdc), 10e6, EIP3009, _path(address(usdc), FEE, address(wBRL)))));
        _payAsRelayer(inv, legs);
        assertEq(wBRL.balanceOf(merchant), 53e18);
        _assertRouterEmpty();
    }

    function test_revert_invalidPath_rulesUnchanged() public {
        bytes[4] memory bad = [
            bytes(""),
            _path(address(usdt), FEE, address(wBRL)), // wrong first token
            _path(address(usdc), FEE, address(usdt)), // wrong last token
            abi.encodePacked(address(usdc), uint24(FEE), address(wBRL), uint8(1)) // bad length
        ];
        for (uint256 i; i < bad.length; ++i) {
            ICobraRouter.Invoice memory inv = _invoice(1e18 + i);
            ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_leg(address(usdc), 1e6, EIP3009, bad[i])));
            vm.expectRevert(ICobraRouter.InvalidPath.selector);
            _payAsRelayer(inv, legs);
        }
    }

    function test_revert_invalidLegs_zeroAndFour() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        vm.expectRevert(ICobraRouter.InvalidLegs.selector);
        _payAsRelayer(inv, new ICobraRouter.Leg[](0));
        ICobraRouter.Leg[] memory four = new ICobraRouter.Leg[](4);
        vm.expectRevert(ICobraRouter.InvalidLegs.selector);
        _payAsRelayer(inv, four);
    }

    function test_revert_expired() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_oneOrderLeg(BUY, OUT, IN, EIP3009)));
        vm.warp(inv.deadline + 1);
        vm.expectRevert(ICobraRouter.Expired.selector);
        _payAsRelayer(inv, legs);
    }

    function test_constructor_rejectsZero_and_immutables() public {
        vm.expectRevert(bytes("ZERO_ADDRESS"));
        new CobraRouterV2(address(permit2), address(swapRouter), address(0));
        vm.expectRevert(bytes("ZERO_ADDRESS"));
        new CobraRouterV2(address(0), address(swapRouter), address(reactor));
        vm.expectRevert(bytes("ZERO_ADDRESS"));
        new CobraRouterV2(address(permit2), address(0), address(reactor));
        assertEq(router.TEXTILE_REACTOR(), address(reactor));
        assertEq(router.PERMIT2(), address(permit2));
        assertEq(router.SWAP_ROUTER(), address(swapRouter));
    }

    function test_guardReleased_afterTextilePay() public {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        _payAsRelayer(inv, _sign(inv, _legs1(_oneOrderLeg(BUY, OUT, IN, EIP3009))));
        // lock and fill flag are transient: the callback is still refused, a new pay in the same tx works
        vm.prank(address(reactor));
        vm.expectRevert(CobraRouterV2.UnauthorizedCallback.selector);
        router.reactorCallback(new IUniswapXReactor.ResolvedOrder[](0), "");
        ICobraRouter.Invoice memory inv2 = _invoice(BUY - 1);
        _payAsRelayer(inv2, _sign(inv2, _legs1(_oneOrderLeg(BUY - 1, OUT, IN, EIP3009))));
        assertEq(wBRL.balanceOf(merchant), 2 * BUY - 1);
    }

    // ───────────────────────────── fuzz ─────────────────────────────

    /// Exact payout or full revert; payer never spends more than signed; router always empty.
    function testFuzz_textile_exactOrRevert(uint256 buy, uint256 out, uint256 amountIn, uint256 amountOut) public {
        buy = bound(buy, 1, 1e30);
        out = bound(out, 10_000, 1e12); // fee must not round to 0 (Textile controller reverts then)
        amountIn = bound(amountIn, 1, 1e12);
        amountOut = bound(amountOut, 1, 1e30);
        usdt.mint(payer, 1e12);
        wBRL.mint(maker, 1e30);
        uint256 usdtBefore = usdt.balanceOf(payer);
        uint256 brlBefore = wBRL.balanceOf(payer);

        ICobraRouter.Invoice memory inv = _invoice(amountOut);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_oneOrderLeg(buy, out, amountIn, EIP3009)));
        vm.prank(relayer);
        try router.pay(inv, payer, legs) {
            assertEq(wBRL.balanceOf(merchant), amountOut);
            assertEq(usdtBefore - usdt.balanceOf(payer), _withFee(out, FEE_BPS));
            assertLe(_withFee(out, FEE_BPS), amountIn);
            assertEq(wBRL.balanceOf(payer) - brlBefore, buy - amountOut);
        } catch {
            assertEq(wBRL.balanceOf(merchant), 0);
            assertEq(usdt.balanceOf(payer), usdtBefore);
            assertTrue(amountIn < _withFee(out, FEE_BPS) || buy < amountOut);
        }
        _assertRouterEmpty();
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _expectInvalidOrder(SignedOrder[] memory orders) internal {
        ICobraRouter.Invoice memory inv = _invoice(BUY);
        ICobraRouter.Leg[] memory legs = _sign(inv, _legs1(_textileLeg(IN, EIP3009, orders)));
        vm.expectRevert(CobraRouterV2.InvalidTextileOrder.selector);
        _payAsRelayer(inv, legs);
        assertEq(usdt.balanceOf(payer), 100_000e6, "nothing pulled");
    }

    function _restrict(LimitOrder memory o, address filler) internal {
        address[] memory fillers = new address[](1);
        fillers[0] = filler;
        o.info.additionalValidationContract = IValidationCallback(address(new MockFillerValidation()));
        o.info.additionalValidationData = abi.encode(fillers, block.timestamp + QUOTE_TTL);
    }

    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    function _evilWorld() internal returns (ReactorReentrantToken evil) {
        evil = new ReactorReentrantToken();
        evil.mint(payer, 1_000e6);
        vm.prank(payer);
        evil.approve(address(permit2), type(uint256).max);
    }

    function _evilLeg(ReactorReentrantToken evil, uint256 nonce) internal view returns (ICobraRouter.Leg memory) {
        LimitOrder memory o = _limitOrder(
            address(reactor), maker, 1000 + nonce, block.timestamp + QUOTE_TTL, address(wBRL), BUY, address(evil), OUT
        );
        return _leg(address(evil), IN, PERMIT2, _textilePath(_orders1(_signed(MAKER_PK, o))));
    }
}
