// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICobraRouter} from "../../src/ICobraRouter.sol";
import {CobraRouter} from "../../src/CobraRouter.sol";
import {SigUtils} from "../utils/SigUtils.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockEIP3009} from "../mocks/MockEIP3009.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";

/// @notice Drives random multi-leg payments (random tokens, kinds, amounts, slippage, partial fills, senders) and
///         replays, recording ghost accounting for the invariants in RouterInvariant.t.sol.
contract RouterHandler is SigUtils {
    CobraRouter public router;
    MockSwapRouter public swapRouter;
    MockPermit2 public permit2;
    MockERC20 public wARS; // tokenOut
    address[4] public tokens; // [wARS, usdc(3009), usdt(3009), mUSD(plain)]
    uint256[2] public payerPks = [PAYER_PK, OTHER_PK];
    address public merchant = makeAddr("inv-merchant");
    address public relayer = makeAddr("inv-relayer");

    // ghosts
    uint256 public ghost_merchantExpected;
    uint256 public ghost_paidCount;
    uint256 public ghost_failedCount;
    uint256 public ghost_doublePaid;
    uint256 public ghost_replayAttempts;
    mapping(address payer => mapping(address token => uint256)) public ghost_signedIn;
    mapping(bytes32 invoiceHash => uint256) public ghost_timesPaid;
    bytes32[] public paidHashes;
    bytes[] internal paidCalls;
    uint256 internal nonce;

    constructor(
        CobraRouter router_,
        MockSwapRouter swapRouter_,
        MockPermit2 permit2_,
        MockERC20 wARS_,
        address usdc,
        address usdt,
        address mUSD
    ) {
        router = router_;
        swapRouter = swapRouter_;
        permit2 = permit2_;
        wARS = wARS_;
        tokens = [address(wARS_), usdc, usdt, mUSD];
    }

    function paidHashesLength() external view returns (uint256) {
        return paidHashes.length;
    }

    function _rateOf(address token) internal view returns (uint256 num) {
        (num,,) = swapRouter.rates(token, address(wARS));
        if (token == address(wARS)) num = 1;
    }

    /// @param seed packs per-leg choices; slipBps sets amountOut vs expected output (some calls must revert).
    function pay(uint256 seed, uint8 nLegs, uint256 slipBps, uint256 payerIdx, bool consumeHalf) external {
        nLegs = uint8(bound(nLegs, 1, 3));
        slipBps = bound(slipBps, 9_000, 10_500);
        uint256 pk = payerPks[payerIdx % 2];
        address payer = vm.addr(pk);
        swapRouter.setConsumeBps(consumeHalf ? 5_000 : 10_000);

        ICobraRouter.Leg[] memory legs = new ICobraRouter.Leg[](nLegs);
        uint256 expectedOut;
        bool needsSender;
        for (uint256 i; i < nLegs; ++i) {
            uint256 s = uint256(keccak256(abi.encode(seed, i)));
            address token = tokens[s % 4];
            // EIP3009 only for usdc/usdt; PERMIT2 and ALLOWANCE work for all
            ICobraRouter.PullKind kind = ICobraRouter.PullKind((s >> 8) % 3);
            if (kind == ICobraRouter.PullKind.EIP3009 && (token == tokens[0] || token == tokens[3])) {
                kind = ICobraRouter.PullKind.PERMIT2;
            }
            if (kind == ICobraRouter.PullKind.ALLOWANCE) needsSender = true;
            uint256 dec = MockERC20(token).decimals();
            uint256 amountIn = bound(s >> 16, 1, 1_000 * 10 ** dec);
            bytes memory path = token == address(wARS) ? bytes("") : _path(token, 100, address(wARS));
            legs[i] = _leg(token, amountIn, kind, path);
            uint256 swapped = token == address(wARS) ? amountIn : amountIn * swapRouter.consumeBps() / 10_000;
            expectedOut += swapped * _rateOf(token);
        }
        if (expectedOut == 0) return;
        uint256 amountOut = expectedOut * slipBps / 10_000;
        if (amountOut == 0) amountOut = 1;

        ICobraRouter.Invoice memory inv = ICobraRouter.Invoice({
            id: keccak256(abi.encode("inv", ++nonce)),
            merchant: merchant,
            tokenOut: address(wARS),
            amountOut: amountOut,
            deadline: block.timestamp + 1 hours
        });
        _sign(router, pk, inv, legs);

        address sender = needsSender ? payer : relayer;
        vm.prank(sender);
        try router.pay(inv, payer, legs) {
            ghost_merchantExpected += amountOut;
            ghost_paidCount++;
            bytes32 h = router.hashInvoice(inv);
            if (++ghost_timesPaid[h] > 1) ghost_doublePaid++;
            paidHashes.push(h);
            paidCalls.push(abi.encode(inv, payer, legs, sender));
            for (uint256 i; i < nLegs; ++i) {
                ghost_signedIn[payer][legs[i].token] += legs[i].amountIn;
            }
        } catch {
            ghost_failedCount++;
        }
    }

    /// @notice Replays a past successful call verbatim (and from a random sender): must always fail.
    function replay(uint256 idx, bool asRelayer) external {
        if (paidCalls.length == 0) return;
        idx = idx % paidCalls.length;
        (ICobraRouter.Invoice memory inv, address payer, ICobraRouter.Leg[] memory legs, address sender) =
            abi.decode(paidCalls[idx], (ICobraRouter.Invoice, address, ICobraRouter.Leg[], address));
        ghost_replayAttempts++;
        vm.prank(asRelayer ? relayer : sender);
        try router.pay(inv, payer, legs) {
            ghost_doublePaid++;
            ghost_timesPaid[router.hashInvoice(inv)]++;
        } catch {}
    }

    /// @notice Price moves between quote and pay.
    function moveRate(uint256 tokenIdx, uint256 bps) external {
        address token = tokens[1 + tokenIdx % 3];
        bps = bound(bps, 9_500, 10_500);
        uint256 num = _rateOf(token) * bps / 10_000;
        if (num == 0) num = 1;
        swapRouter.setRate(token, address(wARS), num, 1);
    }
}
