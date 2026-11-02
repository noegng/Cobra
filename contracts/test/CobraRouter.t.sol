// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICobraRouter} from "../src/ICobraRouter.sol";
import {CobraRouter} from "../src/CobraRouter.sol";
import {RouterTestBase} from "./utils/RouterTestBase.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";

contract CobraRouterTest is RouterTestBase {
    ICobraRouter.PullKind internal constant EIP3009 = ICobraRouter.PullKind.EIP3009;
    ICobraRouter.PullKind internal constant PERMIT2 = ICobraRouter.PullKind.PERMIT2;
    ICobraRouter.PullKind internal constant ALLOWANCE = ICobraRouter.PullKind.ALLOWANCE;

    bytes internal constant BAD_3009_SIG = bytes("FiatTokenV2: invalid signature");
    bytes internal constant BAD_PERMIT2_SIG = bytes("InvalidSigner");

    event Paid(
        bytes32 indexed invoiceId, address indexed payer, address indexed merchant, address tokenOut, uint256 amountOut
    );

    // ───────────────────────────── happy paths ─────────────────────────────

    function test_sameToken_permit2() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        ICobraRouter.Leg[] memory legs = _signed(inv, _legs1(_directLeg(4500e18, PERMIT2)));
        uint256 payerBefore = wARS.balanceOf(payer);

        vm.expectEmit(true, true, true, true, address(router));
        emit Paid(inv.id, payer, merchant, address(wARS), 4500e18);
        _payAsRelayer(inv, legs);

        assertEq(wARS.balanceOf(merchant), 4500e18);
        assertEq(payerBefore - wARS.balanceOf(payer), 4500e18);
        assertTrue(router.isPaid(router.hashInvoice(inv)));
        _assertRouterEmpty();
    }

    function test_sameToken_eip3009_usdcAsTokenOut() public {
        ICobraRouter.Invoice memory inv = _invoice(25e6);
        inv.tokenOut = address(usdc);
        ICobraRouter.Leg[] memory legs = _signed(inv, _legs1(_leg(address(usdc), 25e6, EIP3009, "")));
        _payAsRelayer(inv, legs);
        assertEq(usdc.balanceOf(merchant), 25e6);
        _assertRouterEmpty();
    }

    function test_sameToken_allowance_surplusRefund() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        ICobraRouter.Leg[] memory legs = _legs1(_directLeg(4600e18, ALLOWANCE));
        uint256 payerBefore = wARS.balanceOf(payer);
        vm.startPrank(payer);
        wARS.approve(address(router), 4600e18);
        router.pay(inv, payer, legs);
        vm.stopPrank();
        assertEq(wARS.balanceOf(merchant), 4500e18);
        assertEq(payerBefore - wARS.balanceOf(payer), 4500e18, "surplus 100 wARS refunded");
        assertEq(wARS.allowance(payer, address(router)), 0);
        _assertRouterEmpty();
    }

    function test_oneSwap_eip3009() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        // 2.73 USDC * 1650 = 4504.5 wARS -> surplus 4.5 wARS to payer
        ICobraRouter.Leg[] memory legs = _signed(inv, _legs1(_usdcLeg(2_730_000)));
        uint256 usdcBefore = usdc.balanceOf(payer);
        uint256 warsBefore = wARS.balanceOf(payer);

        _payAsRelayer(inv, legs);

        assertEq(wARS.balanceOf(merchant), 4500e18);
        assertEq(usdcBefore - usdc.balanceOf(payer), 2_730_000);
        assertEq(wARS.balanceOf(payer) - warsBefore, 4.5e18, "exact surplus");
        assertEq(swapRouter.calls(), 1);
        _assertRouterEmpty();
    }

    function test_twoLegs_eip3009_permit2() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        // 1.5 USDC -> 2475 wARS ; 1.23 USDT -> 2029.5 wARS ; total 4504.5
        ICobraRouter.Leg[] memory legs = _signed(inv, _legs2(_usdcLeg(1_500_000), _usdtLeg(1_230_000, PERMIT2)));
        uint256 warsBefore = wARS.balanceOf(payer);
        _payAsRelayer(inv, legs);
        assertEq(wARS.balanceOf(merchant), 4500e18);
        assertEq(wARS.balanceOf(payer) - warsBefore, 4.5e18);
        assertEq(swapRouter.calls(), 2);
        _assertRouterEmpty();
    }

    function test_threeLegs_mixedKinds_payerIsSender() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        // 1 USDC (EIP3009, 2 hops) -> 1650 ; 1 USDT (Permit2) -> 1650 ; 1200 wARS (allowance) ; total 4500 exact
        ICobraRouter.Leg[] memory legs = _signed(
            inv,
            _legs3(
                _leg(address(usdc), 1e6, EIP3009, _path(address(usdc), FEE, address(usdt), FEE, address(wARS))),
                _usdtLeg(1e6, PERMIT2),
                _directLeg(1200e18, ALLOWANCE)
            )
        );
        uint256 warsBefore = wARS.balanceOf(payer);
        vm.startPrank(payer);
        wARS.approve(address(router), 1200e18);
        router.pay(inv, payer, legs);
        vm.stopPrank();
        assertEq(wARS.balanceOf(merchant), 4500e18);
        assertEq(warsBefore - wARS.balanceOf(payer), 1200e18, "no surplus");
        assertEq(usdc.balanceOf(payer), 100_000e6 - 1e6);
        assertEq(usdt.balanceOf(payer), 100_000e6 - 1e6);
        _assertRouterEmpty();
    }

    function test_threeLegs_allSigned_relayed() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        ICobraRouter.Leg[] memory legs = _signed(
            inv,
            _legs3(_usdcLeg(1e6), _usdtLeg(1e6, EIP3009), _directLeg(1200e18, PERMIT2))
        );
        _payAsRelayer(inv, legs);
        assertEq(wARS.balanceOf(merchant), 4500e18);
        _assertRouterEmpty();
    }

    function test_deadlineInclusive() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        ICobraRouter.Leg[] memory legs = _signed(inv, _legs1(_directLeg(4500e18, PERMIT2)));
        vm.warp(inv.deadline);
        _payAsRelayer(inv, legs);
        assertEq(wARS.balanceOf(merchant), 4500e18);
    }

    function test_partialFill_residueRefundedToPayer() public {
        swapRouter.setConsumeBps(5_000); // pool stops at its price limit: only half of amountIn is swapped
        ICobraRouter.Invoice memory inv = _invoice(3000e18);
        ICobraRouter.Leg[] memory legs = _signed(inv, _legs1(_usdcLeg(4e6)));
        uint256 usdcBefore = usdc.balanceOf(payer);
        uint256 warsBefore = wARS.balanceOf(payer);
        _payAsRelayer(inv, legs);
        assertEq(wARS.balanceOf(merchant), 3000e18);
        assertEq(usdcBefore - usdc.balanceOf(payer), 2e6, "unswapped 2 USDC refunded");
        assertEq(wARS.balanceOf(payer) - warsBefore, 300e18, "3300 out - 3000 owed");
        _assertRouterEmpty();
    }

    // ───────────────────────────── fuzz: exact merchant amount & exact surplus ─────────────────────────────

    function testFuzz_exactPayoutOrRevert(uint256 amountIn, uint256 rate, uint256 amountOut) public {
        amountIn = bound(amountIn, 1, 100_000e6);
        rate = bound(rate, 1, 5_000e12);
        amountOut = bound(amountOut, 1, 1e30);
        swapRouter.setRate(address(usdc), address(wARS), rate, 1);
        uint256 out = amountIn * rate;

        ICobraRouter.Invoice memory inv = _invoice(amountOut);
        ICobraRouter.Leg[] memory legs = _signed(inv, _legs1(_usdcLeg(amountIn)));
        uint256 usdcBefore = usdc.balanceOf(payer);
        uint256 warsBefore = wARS.balanceOf(payer);

        if (out < amountOut) {
            vm.expectRevert(abi.encodeWithSelector(ICobraRouter.InsufficientOutput.selector, out, amountOut));
            _payAsRelayer(inv, legs);
            assertEq(wARS.balanceOf(merchant), 0);
            assertEq(usdc.balanceOf(payer), usdcBefore);
            assertFalse(router.isPaid(router.hashInvoice(inv)));
        } else {
            _payAsRelayer(inv, legs);
            assertEq(wARS.balanceOf(merchant), amountOut);
            assertEq(usdcBefore - usdc.balanceOf(payer), amountIn);
            assertEq(wARS.balanceOf(payer) - warsBefore, out - amountOut);
        }
        _assertRouterEmpty();
    }

    // ───────────────────────────── reverts: core checks ─────────────────────────────

    function test_revert_insufficientOutput_stateUnchanged() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        ICobraRouter.Leg[] memory legs = _signed(inv, _legs1(_usdcLeg(2_730_000)));
        swapRouter.setRate(address(usdc), address(wARS), 1600e12, 1); // price moved: 2.73 * 1600 = 4368
        uint256 usdcBefore = usdc.balanceOf(payer);
        vm.expectRevert(abi.encodeWithSelector(ICobraRouter.InsufficientOutput.selector, 4368e18, 4500e18));
        _payAsRelayer(inv, legs);
        assertEq(usdc.balanceOf(payer), usdcBefore);
        assertEq(wARS.balanceOf(merchant), 0);
        assertFalse(router.isPaid(router.hashInvoice(inv)));
        // price recovers: the same signatures still work (nothing was consumed)
        swapRouter.setRate(address(usdc), address(wARS), 1650e12, 1);
        _payAsRelayer(inv, legs);
        assertEq(wARS.balanceOf(merchant), 4500e18);
    }

    function test_revert_insufficientOutput_aggregateAcrossLegs() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        // 1650 + 1650 + 1199 = 4499 < 4500
        ICobraRouter.Leg[] memory legs =
            _signed(inv, _legs3(_usdcLeg(1e6), _usdtLeg(1e6, PERMIT2), _directLeg(1199e18, PERMIT2)));
        vm.expectRevert(abi.encodeWithSelector(ICobraRouter.InsufficientOutput.selector, 4499e18, 4500e18));
        _payAsRelayer(inv, legs);
    }

    function test_revert_expired() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        ICobraRouter.Leg[] memory legs = _signed(inv, _legs1(_directLeg(4500e18, PERMIT2)));
        vm.warp(inv.deadline + 1);
        vm.expectRevert(ICobraRouter.Expired.selector);
        _payAsRelayer(inv, legs);
    }

    function test_revert_replay_alreadyPaid() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        ICobraRouter.Leg[] memory legs = _signed(inv, _legs1(_usdcLeg(2_730_000)));
        _payAsRelayer(inv, legs);
        uint256 usdcBefore = usdc.balanceOf(payer);

        vm.expectRevert(ICobraRouter.AlreadyPaid.selector);
        _payAsRelayer(inv, legs);

        // Even a fresh, validly signed intent from another payer cannot pay the same invoice twice.
        address other = vm.addr(OTHER_PK);
        _fund(other);
        ICobraRouter.Leg[] memory legs2 = _legs1(_directLeg(4500e18, PERMIT2));
        _sign(router, OTHER_PK, inv, legs2);
        vm.expectRevert(ICobraRouter.AlreadyPaid.selector);
        router.pay(inv, other, legs2);

        assertEq(usdc.balanceOf(payer), usdcBefore);
        assertEq(wARS.balanceOf(merchant), 4500e18);
    }

    function test_revert_invalidLegs_zeroAndFour() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        vm.expectRevert(ICobraRouter.InvalidLegs.selector);
        _payAsRelayer(inv, new ICobraRouter.Leg[](0));

        ICobraRouter.Leg[] memory four = new ICobraRouter.Leg[](4);
        for (uint256 i; i < 4; ++i) four[i] = _directLeg(1125e18, PERMIT2);
        _sign(router, PAYER_PK, inv, four);
        vm.expectRevert(ICobraRouter.InvalidLegs.selector);
        _payAsRelayer(inv, four);
    }

    function test_revert_allowance_nonPayerSender() public {
        // Victim approved the router (e.g. for a previous self-submitted payment). A third party must not be able
        // to spend that allowance by naming the victim as payer.
        vm.prank(payer);
        wARS.approve(address(router), type(uint256).max);
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        inv.merchant = relayer; // attacker-controlled merchant
        ICobraRouter.Leg[] memory legs = _legs1(_directLeg(4500e18, ALLOWANCE));
        vm.expectRevert(ICobraRouter.PayerMustBeSender.selector);
        _payAsRelayer(inv, legs);
    }

    function test_revert_allowance_inThirdLeg_nonPayerSender() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        ICobraRouter.Leg[] memory legs =
            _signed(inv, _legs3(_usdcLeg(1e6), _usdtLeg(1e6, PERMIT2), _directLeg(1200e18, ALLOWANCE)));
        vm.prank(payer);
        wARS.approve(address(router), 1200e18);
        vm.expectRevert(ICobraRouter.PayerMustBeSender.selector);
        _payAsRelayer(inv, legs);
    }

    // ───────────────────────────── invalid paths ─────────────────────────────

    function _expectInvalidPath(address token, bytes memory path) internal {
        ICobraRouter.Invoice memory inv = _invoice(1e18);
        // pullData left empty: path validation must happen BEFORE any pull/decoding.
        ICobraRouter.Leg[] memory legs = _legs1(_leg(token, 1e6, EIP3009, path));
        vm.expectRevert(ICobraRouter.InvalidPath.selector);
        _payAsRelayer(inv, legs);
    }

    function test_revert_invalidPath_directWithPath() public {
        _expectInvalidPath(address(wARS), _path(address(wARS), FEE, address(wARS)));
    }

    function test_revert_invalidPath_swapWithEmptyPath() public {
        _expectInvalidPath(address(usdc), "");
    }

    function test_revert_invalidPath_wrongFirstToken() public {
        _expectInvalidPath(address(usdc), _path(address(usdt), FEE, address(wARS)));
    }

    function test_revert_invalidPath_wrongLastToken() public {
        _expectInvalidPath(address(usdc), _path(address(usdc), FEE, address(usdt)));
    }

    function test_revert_invalidPath_badLength() public {
        bytes memory p = _path(address(usdc), FEE, address(wARS));
        _expectInvalidPath(address(usdc), abi.encodePacked(p, bytes1(0))); // 44 bytes
        _expectInvalidPath(address(usdc), abi.encodePacked(address(usdc), bytes2(0), address(wARS))); // 42 bytes
        _expectInvalidPath(address(usdc), abi.encodePacked(address(usdc))); // 20 bytes
    }

    function test_revert_invalidPath_tooManyHops() public {
        bytes memory p = abi.encodePacked(address(usdc));
        for (uint256 i; i < 4; ++i) p = abi.encodePacked(p, FEE, address(usdt));
        p = abi.encodePacked(p, FEE, address(wARS)); // 5 hops
        _expectInvalidPath(address(usdc), p);
    }

    function test_fourHops_ok() public {
        bytes memory p = abi.encodePacked(address(usdc));
        for (uint256 i; i < 3; ++i) p = abi.encodePacked(p, FEE, address(usdt));
        p = abi.encodePacked(p, FEE, address(wARS)); // 4 hops
        ICobraRouter.Invoice memory inv = _invoice(1650e18);
        ICobraRouter.Leg[] memory legs = _signed(inv, _legs1(_leg(address(usdc), 1e6, EIP3009, p)));
        _payAsRelayer(inv, legs);
        assertEq(wARS.balanceOf(merchant), 1650e18);
    }

    // ───────────────────────────── relayer tampering ─────────────────────────────

    /// Fresh EIP-3009-only intent: [USDC→wARS, USDT→wARS], signed by the payer.
    function _intent3009() internal view returns (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs) {
        inv = _invoice(4500e18);
        legs = _signed(inv, _legs2(_usdcLeg(1_500_000), _usdtLeg(1_230_000, EIP3009)));
    }

    /// Fresh Permit2-only intent: [USDT→wARS, wARS direct], signed by the payer.
    function _intentPermit2() internal view returns (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs) {
        inv = _invoice(4500e18);
        inv.id = keccak256("permit2-intent"); // distinct from _intent3009's invoice
        legs = _signed(inv, _legs2(_usdtLeg(1e6, PERMIT2), _directLeg(2850e18, PERMIT2)));
    }

    function _expectFail(ICobraRouter.Invoice memory inv, address p, ICobraRouter.Leg[] memory legs, bytes memory why)
        internal
    {
        if (why.length == 0) vm.expectRevert();
        else vm.expectRevert(why);
        vm.prank(relayer);
        router.pay(inv, p, legs);
    }

    function _bothKinds(uint256 which)
        internal
        view
        returns (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs, bytes memory badSig)
    {
        if (which == 0) {
            (inv, legs) = _intent3009();
            badSig = BAD_3009_SIG;
        } else {
            (inv, legs) = _intentPermit2();
            badSig = BAD_PERMIT2_SIG;
        }
    }

    function test_tamper_merchant() public {
        for (uint256 k; k < 2; ++k) {
            (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs, bytes memory bad) = _bothKinds(k);
            inv.merchant = relayer;
            _expectFail(inv, payer, legs, bad);
        }
    }

    function test_tamper_amountOut() public {
        for (uint256 k; k < 2; ++k) {
            (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs, bytes memory bad) = _bothKinds(k);
            inv.amountOut -= 1000e18; // relayer tries to skim the surplus
            _expectFail(inv, payer, legs, bad);
        }
    }

    function test_tamper_invoiceIdAndDeadline() public {
        for (uint256 k; k < 2; ++k) {
            (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs, bytes memory bad) = _bothKinds(k);
            inv.id = keccak256("other");
            _expectFail(inv, payer, legs, bad);
            (inv, legs, bad) = _bothKinds(k);
            inv.deadline += 1;
            _expectFail(inv, payer, legs, bad);
        }
    }

    function test_tamper_tokenOut() public {
        for (uint256 k; k < 2; ++k) {
            (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs,) = _bothKinds(k);
            inv.tokenOut = address(mUSD);
            _expectFail(inv, payer, legs, ""); // path / signature mismatch
        }
    }

    function test_tamper_amountIn() public {
        for (uint256 k; k < 2; ++k) {
            (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs, bytes memory bad) = _bothKinds(k);
            legs[0].amountIn += 1;
            _expectFail(inv, payer, legs, bad);
            (inv, legs, bad) = _bothKinds(k);
            legs[0].amountIn -= 1;
            _expectFail(inv, payer, legs, bad);
        }
    }

    function test_tamper_path() public {
        for (uint256 k; k < 2; ++k) {
            (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs, bytes memory bad) = _bothKinds(k);
            legs[0].path = _path(legs[0].token, 500, address(wARS)); // other fee tier (worse pool)
            _expectFail(inv, payer, legs, bad);
            (inv, legs, bad) = _bothKinds(k);
            legs[0].path = _path(legs[0].token, FEE, address(mUSD), FEE, address(wARS)); // extra hop
            _expectFail(inv, payer, legs, bad);
        }
    }

    function test_tamper_legToken() public {
        (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs) = _intent3009();
        legs[0].token = address(usdt);
        legs[0].path = _path(address(usdt), FEE, address(wARS));
        _expectFail(inv, payer, legs, BAD_3009_SIG);
    }

    function test_tamper_legOrder() public {
        for (uint256 k; k < 2; ++k) {
            (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs, bytes memory bad) = _bothKinds(k);
            (legs[0], legs[1]) = (legs[1], legs[0]);
            _expectFail(inv, payer, legs, bad);
        }
    }

    function test_tamper_dropLeg() public {
        for (uint256 k; k < 2; ++k) {
            (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs, bytes memory bad) = _bothKinds(k);
            _expectFail(inv, payer, _legs1(legs[0]), bad);
        }
    }

    function test_tamper_payer() public {
        address other = vm.addr(OTHER_PK);
        _fund(other);
        for (uint256 k; k < 2; ++k) {
            (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs, bytes memory bad) = _bothKinds(k);
            _expectFail(inv, other, legs, bad);
        }
    }

    function test_tamper_kind() public {
        (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs) = _intent3009();
        legs[0].kind = PERMIT2; // pullData no longer decodes / witness changes
        _expectFail(inv, payer, legs, "");
        (inv, legs) = _intentPermit2();
        legs[0].kind = ALLOWANCE; // even with a standing allowance, relayer != payer
        vm.prank(payer);
        usdt.approve(address(router), type(uint256).max);
        _expectFail(inv, payer, legs, abi.encodeWithSelector(ICobraRouter.PayerMustBeSender.selector));
    }

    function test_tamper_swapPullDataBetweenLegs() public {
        for (uint256 k; k < 2; ++k) {
            (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs,) = _bothKinds(k);
            (legs[0].pullData, legs[1].pullData) = (legs[1].pullData, legs[0].pullData);
            _expectFail(inv, payer, legs, "");
        }
    }

    function test_tamper_untouchedIntentStillPays() public {
        // After all the failed attempts above (each in its own test), sanity: the genuine intents pay.
        for (uint256 k; k < 2; ++k) {
            (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs,) = _bothKinds(k);
            inv.merchant = relayer;
            _expectFail(inv, payer, legs, "");
            (inv, legs,) = _bothKinds(k);
            _payAsRelayer(inv, legs);
        }
        assertEq(wARS.balanceOf(merchant), 9000e18);
    }

    // ───────────────────────────── signatures are router-bound ─────────────────────────────

    function test_eip3009Auth_notUsableOutsideRouter() public {
        (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs) = _intent3009();
        bytes32 digest = router.intentDigest(inv, payer, legs);
        (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) =
            abi.decode(legs[0].pullData, (uint256, uint256, uint8, bytes32, bytes32));
        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: caller must be the payee"));
        usdc.receiveWithAuthorization(payer, address(router), 1_500_000, va, vb, _legNonce(digest, 0), v, r, s);
        vm.prank(relayer);
        vm.expectRevert(BAD_3009_SIG);
        usdc.receiveWithAuthorization(payer, relayer, 1_500_000, va, vb, _legNonce(digest, 0), v, r, s);
    }

    function test_permit2Sig_notUsableOutsideRouter() public {
        (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs) = _intentPermit2();
        bytes32 witness = router.hashIntent(inv, payer, legs);
        (uint256 nonce, uint256 deadline, bytes memory sig) = abi.decode(legs[0].pullData, (uint256, uint256, bytes));
        vm.prank(relayer);
        vm.expectRevert(BAD_PERMIT2_SIG); // spender = msg.sender = relayer != router
        permit2.permitWitnessTransferFrom(
            ISignatureTransfer.PermitTransferFrom(ISignatureTransfer.TokenPermissions(address(usdt), 1e6), nonce, deadline),
            ISignatureTransfer.SignatureTransferDetails(relayer, 1e6),
            payer,
            witness,
            WITNESS_TYPE_STRING,
            sig
        );
    }

    // ───────────────────────────── front-running / griefing ─────────────────────────────

    function test_frontRun_copiedCalldata_paysOnce() public {
        (ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs) = _intent3009();
        address mev = makeAddr("mev");
        vm.prank(mev);
        router.pay(inv, payer, legs); // front-runner submits the same calldata: same outcome
        vm.expectRevert(ICobraRouter.AlreadyPaid.selector);
        _payAsRelayer(inv, legs);
        assertEq(wARS.balanceOf(merchant), 4500e18);
        assertEq(wARS.balanceOf(mev), 0);
    }

    function test_griefing_sameIdDifferentTerms_doesNotBlockRealInvoice() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        // attacker pays a fake invoice with the same id but tiny amount to their own address
        address attacker = vm.addr(OTHER_PK);
        _fund(attacker);
        ICobraRouter.Invoice memory fake = inv;
        fake = ICobraRouter.Invoice(inv.id, attacker, inv.tokenOut, 1, inv.deadline);
        vm.startPrank(attacker);
        wARS.approve(address(router), 1);
        router.pay(fake, attacker, _legs1(_directLeg(1, ALLOWANCE)));
        vm.stopPrank();
        // the real invoice is still payable
        _payAsRelayer(inv, _signed(inv, _legs1(_directLeg(4500e18, PERMIT2))));
        assertEq(wARS.balanceOf(merchant), 4500e18);
    }

    // ───────────────────────────── token quirks ─────────────────────────────

    function test_feeOnTransfer_legSwapsMeasuredDelta() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(100); // 1%
        fot.mint(payer, 1000e18);
        vm.prank(payer);
        fot.approve(address(permit2), type(uint256).max);
        ICobraRouter.Invoice memory inv = _invoice(99e18);
        // router receives 99 (not 100) and must approve/swap exactly 99; mock pays 1:1 minus fee on its pull
        ICobraRouter.Leg[] memory legs =
            _signed(inv, _legs1(_leg(address(fot), 100e18, PERMIT2, _path(address(fot), FEE, address(wARS)))));
        _payAsRelayer(inv, legs);
        assertEq(wARS.balanceOf(merchant), 99e18);
        assertEq(fot.balanceOf(address(router)), 0);
        assertEq(fot.allowance(address(router), address(swapRouter)), 0);
    }

    function test_feeOnTransfer_tokenOut_shortInbound_reverts() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(100);
        fot.mint(payer, 1000e18);
        ICobraRouter.Invoice memory inv = _invoice(100e18);
        inv.tokenOut = address(fot);
        vm.startPrank(payer);
        fot.approve(address(router), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ICobraRouter.InsufficientOutput.selector, 99e18, 100e18));
        router.pay(inv, payer, _legs1(_leg(address(fot), 100e18, ALLOWANCE, "")));
        vm.stopPrank();
    }

    function test_feeOnTransfer_tokenOut_merchantShortPaid_reverts() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(100);
        fot.mint(payer, 1000e18);
        ICobraRouter.Invoice memory inv = _invoice(100e18);
        inv.tokenOut = address(fot);
        vm.startPrank(payer);
        fot.approve(address(router), type(uint256).max);
        // router gets 198 >= 100, but the merchant would only receive 99: must revert, never underpay.
        vm.expectRevert(abi.encodeWithSelector(ICobraRouter.InsufficientOutput.selector, 99e18, 100e18));
        router.pay(inv, payer, _legs1(_leg(address(fot), 200e18, ALLOWANCE, "")));
        vm.stopPrank();
    }

    function test_noReturnTokens_usdtStyle() public {
        vm.startPrank(payer);
        mUSD.approve(address(router), 2e18);
        wARS.approve(address(router), 1300e18);
        vm.stopPrank();
        mUSD.setNoReturn(true);
        wARS.setNoReturn(true);
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        ICobraRouter.Leg[] memory legs = _legs2(
            _leg(address(mUSD), 2e18, ALLOWANCE, _path(address(mUSD), FEE, address(wARS))),
            _directLeg(1300e18, ALLOWANCE)
        ); // 3300 + 1300 = 4600 -> 100 surplus
        uint256 warsBefore = wARS.balanceOf(payer);
        vm.prank(payer);
        router.pay(inv, payer, legs);
        assertEq(wARS.balanceOf(merchant), 4500e18);
        assertEq(warsBefore - wARS.balanceOf(payer), 1200e18);
        _assertRouterEmpty();
    }

    function test_returnFalseToken_reverts() public {
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        vm.startPrank(payer);
        wARS.approve(address(router), type(uint256).max);
        wARS.setReturnFalse(true);
        vm.expectRevert(bytes("STF"));
        router.pay(inv, payer, _legs1(_directLeg(4500e18, ALLOWANCE)));
        vm.stopPrank();
    }

    function test_codelessToken_reverts() public {
        ICobraRouter.Invoice memory inv = _invoice(1);
        inv.tokenOut = makeAddr("eoa");
        vm.expectRevert();
        vm.prank(payer);
        router.pay(inv, payer, _legs1(_leg(inv.tokenOut, 1, ALLOWANCE, "")));
    }

    // ───────────────────────────── reentrancy ─────────────────────────────

    function test_reentrancy_blocked() public {
        ReentrantToken evil = new ReentrantToken();
        evil.mint(payer, 1000e18);
        vm.prank(payer);
        evil.approve(address(router), type(uint256).max);

        ICobraRouter.Invoice memory inv = _invoice(100e18);
        inv.tokenOut = address(evil);
        ICobraRouter.Invoice memory inv2 = _invoice(200e18);
        inv2.tokenOut = address(evil);
        inv2.merchant = makeAddr("thief");
        ICobraRouter.Leg[] memory legs = _legs1(_leg(address(evil), 100e18, ALLOWANCE, ""));
        ICobraRouter.Leg[] memory legs2 = _legs1(_leg(address(evil), 200e18, ALLOWANCE, ""));

        // On the pull, the token re-enters pay() for another invoice (nested call from the token, msg.sender = token).
        evil.arm(address(router), abi.encodeCall(ICobraRouter.pay, (inv2, address(evil), legs2)));
        vm.prank(payer);
        router.pay(inv, payer, legs);

        assertTrue(evil.attempted());
        assertFalse(evil.innerSuccess());
        assertEq(evil.innerRevertData(), abi.encodeWithSignature("Error(string)", "REENTRANCY"));
        assertEq(evil.balanceOf(merchant), 100e18);
        assertFalse(router.isPaid(router.hashInvoice(inv2)));
        assertEq(evil.balanceOf(address(router)), 0);
    }

    function test_reentrancy_sameInvoice_blocked() public {
        ReentrantToken evil = new ReentrantToken();
        evil.mint(payer, 1000e18);
        vm.prank(payer);
        evil.approve(address(router), type(uint256).max);
        ICobraRouter.Invoice memory inv = _invoice(100e18);
        inv.tokenOut = address(evil);
        ICobraRouter.Leg[] memory legs = _legs1(_leg(address(evil), 100e18, ALLOWANCE, ""));
        evil.arm(address(router), abi.encodeCall(ICobraRouter.pay, (inv, payer, legs)));
        vm.prank(payer);
        router.pay(inv, payer, legs);
        assertFalse(evil.innerSuccess());
        assertEq(evil.balanceOf(merchant), 100e18);
    }

    function test_guardReleased_afterCall() public {
        // transient lock is cleared: two payments in the same transaction context both succeed
        ICobraRouter.Invoice memory a = _invoice(1000e18);
        ICobraRouter.Invoice memory b = _invoice(2000e18);
        vm.startPrank(payer);
        wARS.approve(address(router), 3000e18);
        router.pay(a, payer, _legs1(_directLeg(1000e18, ALLOWANCE)));
        router.pay(b, payer, _legs1(_directLeg(2000e18, ALLOWANCE)));
        vm.stopPrank();
        assertEq(wARS.balanceOf(merchant), 3000e18);
    }

    // ───────────────────────────── misc ─────────────────────────────

    function test_domainSeparator_followsChainId() public {
        bytes32 d1 = router.DOMAIN_SEPARATOR();
        vm.chainId(1);
        bytes32 d2 = router.DOMAIN_SEPARATOR();
        assertTrue(d1 != d2);
        assertEq(
            d2,
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256("Cobra Router"),
                    keccak256("1"),
                    uint256(1),
                    address(router)
                )
            )
        );
    }

    function test_constructor_immutables() public view {
        assertEq(router.PERMIT2(), address(permit2));
        assertEq(router.SWAP_ROUTER(), address(swapRouter));
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(bytes("ZERO_ADDRESS"));
        new CobraRouter(address(0), address(swapRouter));
        vm.expectRevert(bytes("ZERO_ADDRESS"));
        new CobraRouter(address(permit2), address(0));
    }

    function test_noReceive() public {
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        (bool ok,) = address(router).call{value: 1}("");
        assertFalse(ok);
    }

    function test_trailingCalldata_erc8021Suffix_ok() public {
        // Relayer appends an ERC-8021 attribution suffix after the ABI calldata.
        ICobraRouter.Invoice memory inv = _invoice(4500e18);
        ICobraRouter.Leg[] memory legs = _signed(inv, _legs1(_directLeg(4500e18, PERMIT2)));
        bytes memory data = abi.encodePacked(
            abi.encodeCall(ICobraRouter.pay, (inv, payer, legs)),
            hex"63656c6f0400",
            hex"80218021802180218021802180218021"
        );
        vm.prank(relayer);
        (bool ok,) = address(router).call(data);
        assertTrue(ok);
        assertEq(wARS.balanceOf(merchant), 4500e18);
    }
}
