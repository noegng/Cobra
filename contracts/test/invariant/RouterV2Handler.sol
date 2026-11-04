// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICobraRouter} from "../../src/ICobraRouter.sol";
import {CobraRouterV2} from "../../src/CobraRouterV2.sol";
import {TextileSigUtils} from "../utils/TextileSigUtils.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";
import {LimitOrder} from "../vendor/textile-uniswapx/uniswapx/lib/LimitOrderLib.sol";
import {SignedOrder} from "../vendor/textile-uniswapx/uniswapx/base/ReactorStructs.sol";

/// @notice Random v2 payments mixing Textile (1–2 maker orders, random buffer / shortfall / maker price), Uniswap and
///         direct legs with random pull kinds, plus native dust left in the reactor and verbatim replays.
contract RouterV2Handler is TextileSigUtils {
    CobraRouterV2 public router;
    address public reactor;
    address public permit2;
    MockSwapRouter public swapRouter;
    MockERC20 public wBRL;
    MockERC20 public usdt;
    MockERC20 public usdc;
    address public merchant = makeAddr("v2-inv-merchant");
    address public relayer = makeAddr("v2-inv-relayer");
    uint256 public constant FEE_BPS = 1;

    uint256 public ghost_merchantExpected;
    uint256 public ghost_paidCount;
    uint256 public ghost_failedCount;
    uint256 public ghost_textilePaid;
    uint256 public ghost_doublePaid;
    uint256 public ghost_nativeDust;
    mapping(address token => uint256) public ghost_signedIn;
    bytes[] internal paidCalls;
    uint256 internal nonce;

    constructor(
        CobraRouterV2 router_,
        address reactor_,
        address permit2_,
        MockSwapRouter swapRouter_,
        MockERC20 wBRL_,
        MockERC20 usdt_,
        MockERC20 usdc_
    ) {
        router = router_;
        reactor = reactor_;
        permit2 = permit2_;
        swapRouter = swapRouter_;
        wBRL = wBRL_;
        usdt = usdt_;
        usdc = usdc_;
    }

    function pay(uint256 seed, uint8 nLegs, uint256 slipBps) external {
        nLegs = uint8(bound(nLegs, 1, 3));
        slipBps = bound(slipBps, 9_500, 10_200);
        address payer = vm.addr(PAYER_PK);
        ICobraRouter.Leg[] memory legs = new ICobraRouter.Leg[](nLegs);
        uint256 expectedOut;
        bool needsSender;
        bool textile;
        for (uint256 i; i < nLegs; ++i) {
            uint256 s = uint256(keccak256(abi.encode(seed, i)));
            ICobraRouter.PullKind kind = ICobraRouter.PullKind((s >> 8) % 3);
            if (kind == ICobraRouter.PullKind.ALLOWANCE) needsSender = true;
            uint256 venue = s % 3;
            if (venue == 0) {
                (legs[i], expectedOut) = _textileLeg(s, kind, expectedOut);
                textile = true;
            } else if (venue == 1) {
                if (kind == ICobraRouter.PullKind.EIP3009) kind = ICobraRouter.PullKind.PERMIT2;
                uint256 amountIn = bound(s >> 16, 1, 1_000e6);
                legs[i] = _leg(address(usdc), amountIn, kind, _path(address(usdc), 100, address(wBRL)));
                expectedOut += swapRouter.quote(address(usdc), address(wBRL), amountIn);
            } else {
                if (kind == ICobraRouter.PullKind.EIP3009) kind = ICobraRouter.PullKind.PERMIT2;
                uint256 amountIn = bound(s >> 16, 1, 1_000e18);
                legs[i] = _leg(address(wBRL), amountIn, kind, "");
                expectedOut += amountIn;
            }
        }
        if (expectedOut == 0) return;
        uint256 amountOut = expectedOut * slipBps / 10_000;
        if (amountOut == 0) amountOut = 1;

        ICobraRouter.Invoice memory inv = ICobraRouter.Invoice({
            id: keccak256(abi.encode("v2-inv", ++nonce)),
            merchant: merchant,
            tokenOut: address(wBRL),
            amountOut: amountOut,
            deadline: block.timestamp + 1 hours
        });
        _sign(router, PAYER_PK, inv, legs);
        address sender = needsSender ? payer : relayer;
        vm.prank(sender);
        try router.pay(inv, payer, legs) {
            ghost_merchantExpected += amountOut;
            ghost_paidCount++;
            if (textile) ghost_textilePaid++;
            for (uint256 i; i < nLegs; ++i) {
                ghost_signedIn[legs[i].token] += legs[i].amountIn;
            }
            paidCalls.push(abi.encode(inv, payer, legs, sender));
        } catch {
            ghost_failedCount++;
        }
    }

    /// @dev Textile USD₮ leg with 1–2 maker orders; amountIn = outputs + fee ± random buffer (shortfall must revert).
    function _textileLeg(uint256 s, ICobraRouter.PullKind kind, uint256 expectedOut)
        internal
        returns (ICobraRouter.Leg memory leg, uint256 newExpected)
    {
        uint256 nOrders = 1 + (s >> 32) % 2;
        SignedOrder[] memory orders = new SignedOrder[](nOrders);
        uint256 cost;
        newExpected = expectedOut;
        for (uint256 j; j < nOrders; ++j) {
            uint256 r = uint256(keccak256(abi.encode(s, j)));
            uint256 out = bound(r, 10_000, 1_000e6);
            uint256 buy = out * bound(r >> 64, 5e12, 6e12); // 5–6 wBRL per USD₮
            uint256 pk = j == 0 ? MAKER_PK : MAKER2_PK;
            LimitOrder memory o = _limitOrder(
                reactor, vm.addr(pk), ++nonce, block.timestamp + 120, address(wBRL), buy, address(usdt), out
            );
            orders[j] = _signOrder(pk, permit2, o);
            cost += _withFee(out, FEE_BPS);
            newExpected += buy;
        }
        // 1/4 of the time the payer signs too little (must revert), otherwise a 0–5% buffer (refunded).
        uint256 amountIn = (s >> 40) % 4 == 0 ? cost - 1 : cost + cost * ((s >> 48) % 500) / 10_000;
        leg = _leg(address(usdt), amountIn, kind, _textilePath(orders));
    }

    function dustReactor(uint96 amount) external {
        uint256 a = bound(amount, 1, 1 ether);
        vm.deal(reactor, reactor.balance + a);
        ghost_nativeDust += a;
    }

    function replay(uint256 idx) external {
        if (paidCalls.length == 0) return;
        (ICobraRouter.Invoice memory inv, address payer, ICobraRouter.Leg[] memory legs, address sender) =
            abi.decode(paidCalls[idx % paidCalls.length], (ICobraRouter.Invoice, address, ICobraRouter.Leg[], address));
        vm.prank(sender);
        try router.pay(inv, payer, legs) {
            ghost_doublePaid++;
        } catch {}
    }
}
