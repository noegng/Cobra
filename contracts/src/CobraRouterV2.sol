// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICobraRouter} from "./ICobraRouter.sol";
import {ICobraRouterV2} from "./ICobraRouterV2.sol";
import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {IUniswapXReactor, IReactorCallback} from "./interfaces/IUniswapXReactor.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";

/// @title CobraRouterV2
/// @notice CobraRouter (v1) + a Textile FX RFQ venue. Immutable, ownerless checkout router: pulls a payer's tokens
///         (EIP-3009 / Permit2 witness / allowance), converts them to `inv.tokenOut` on Uniswap V3 (SwapRouter02) or
///         by filling Textile maker LimitOrders on Textile's UniswapX reactor, and pays the merchant EXACTLY
///         `inv.amountOut`, refunding any surplus to the payer, or reverts entirely.
///         Spec: docs/interfaces.md §2–§3 (unchanged) and §7 (Textile venue).
/// @dev v1 (CobraRouter.sol, deployed) is copied rather than refactored so it stays byte-identical. Differences:
///      - venue selection by `leg.path` (empty: direct, "TXF1" prefix: Textile, otherwise: Uniswap V3 path);
///      - `reactorCallback` (UniswapX filler callback) and `receive`, both accepted only from TEXTILE_REACTOR
///        while this router is inside its own `executeBatchWithCallback` call;
///      - native coin the reactor refunds to its filler (BaseReactor._fill sends out its whole balance) is
///        forwarded to the payer at the end of `pay`.
///      No owner, no upgrade, no fees, no pause, no sweep, no fallback. Holds no funds between calls.
contract CobraRouterV2 is ICobraRouterV2, IReactorCallback {
    using SafeTransfer for address;

    // ───────────────────────────── EIP-712 (identical to v1) ─────────────────────────────

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("Cobra Router");
    bytes32 internal constant VERSION_HASH = keccak256("1");

    bytes32 internal constant INVOICE_TYPEHASH =
        keccak256("Invoice(bytes32 id,address merchant,address tokenOut,uint256 amountOut,uint256 deadline)");
    bytes32 internal constant LEG_COMMITMENT_TYPEHASH =
        keccak256("LegCommitment(address token,uint256 amountIn,uint8 kind,bytes32 pathHash)");
    bytes32 internal constant PAYMENT_INTENT_TYPEHASH = keccak256(
        "PaymentIntent(Invoice invoice,address payer,LegCommitment[] legs)"
        "Invoice(bytes32 id,address merchant,address tokenOut,uint256 amountOut,uint256 deadline)"
        "LegCommitment(address token,uint256 amountIn,uint8 kind,bytes32 pathHash)"
    );

    /// @dev Passed verbatim to Permit2.permitWitnessTransferFrom (== TYPE_STRINGS.PERMIT2_WITNESS in TS).
    string internal constant PERMIT2_WITNESS_TYPE_STRING = "PaymentIntent witness)"
        "Invoice(bytes32 id,address merchant,address tokenOut,uint256 amountOut,uint256 deadline)"
        "LegCommitment(address token,uint256 amountIn,uint8 kind,bytes32 pathHash)"
        "PaymentIntent(Invoice invoice,address payer,LegCommitment[] legs)"
        "TokenPermissions(address token,uint256 amount)";

    // ───────────────────────────── Limits / venues ─────────────────────────────

    uint256 internal constant MAX_LEGS = 3;
    /// @dev Uniswap V3 path: token(20) | fee(3) | token(20) …  Capped at 4 hops (gas-griefing bound).
    uint256 internal constant ADDR_SIZE = 20;
    uint256 internal constant HOP_SIZE = 23;
    uint256 internal constant MAX_HOPS = 4;

    /// @dev Textile venue: path = "TXF1" ++ abi.encode(SignedOrder[]) (packages/shared/src/textile-venue.ts).
    bytes4 internal constant TEXTILE_MAGIC = 0x54584631;
    uint256 internal constant MAGIC_SIZE = 4;

    uint256 private constant VENUE_DIRECT = 0;
    uint256 private constant VENUE_UNISWAP = 1;
    uint256 private constant VENUE_TEXTILE = 2;

    // ───────────────────────────── Errors (v2 only) ─────────────────────────────

    /// @notice A Textile order targets another reactor, does not sell `inv.tokenOut`, or asks for a token other
    ///         than the leg token; or the Textile venue carries no order.
    error InvalidTextileOrder();
    /// @notice `reactorCallback` / native transfer not coming from TEXTILE_REACTOR during this router's own fill.
    error UnauthorizedCallback();

    // ───────────────────────────── State ─────────────────────────────

    address public immutable PERMIT2;
    address public immutable SWAP_ROUTER;
    address public immutable TEXTILE_REACTOR;

    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;

    /// @inheritdoc ICobraRouter
    mapping(bytes32 invoiceHash => bool) public isPaid;

    /// @dev Reentrancy lock in transient storage (EIP-1153). TSTORE/TLOAD verified on Celo mainnet via eth_call.
    bool private transient _locked;
    /// @dev True only around this router's call to TEXTILE_REACTOR.executeBatchWithCallback (inside `pay`).
    bool private transient _inTextileFill;

    constructor(address permit2, address swapRouter, address textileReactor) {
        require(permit2 != address(0) && swapRouter != address(0) && textileReactor != address(0), "ZERO_ADDRESS");
        PERMIT2 = permit2;
        SWAP_ROUTER = swapRouter;
        TEXTILE_REACTOR = textileReactor;
        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    modifier nonReentrant() {
        require(!_locked, "REENTRANCY");
        _locked = true;
        _;
        _locked = false;
    }

    // ───────────────────────────── pay ─────────────────────────────

    /// @inheritdoc ICobraRouter
    function pay(Invoice calldata inv, address payer, Leg[] calldata legs) external nonReentrant {
        // 1. Cheap checks.
        if (block.timestamp > inv.deadline) revert Expired();
        if (legs.length == 0 || legs.length > MAX_LEGS) revert InvalidLegs();

        // 2. Replay protection keyed by the invoice struct hash, set before any external call (CEI).
        bytes32 invoiceHash = _hashInvoice(inv);
        if (isPaid[invoiceHash]) revert AlreadyPaid();
        isPaid[invoiceHash] = true;

        // 3. Intent binding. witness = hashStruct(PaymentIntent); digest seeds the EIP-3009 nonces.
        bytes32 witness = _hashIntent(inv, payer, legs);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), witness));

        address tokenOut = inv.tokenOut;
        uint256 outBefore = IERC20Minimal(tokenOut).balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;

        // 4–5. Pull every leg, convert when needed.
        for (uint256 i; i < legs.length; ++i) {
            _processLeg(legs[i], i, payer, tokenOut, witness, digest);
        }

        // 6–8. Aggregate output check, exact merchant payout, surplus refund, event.
        _settle(inv, payer, tokenOut, outBefore);

        // 9. Native coin the Textile reactor refunded to its filler (stray balance someone left in the reactor)
        //    is not ours: hand it to the payer. Every ERC-20 flow above nets to zero, so on Celo (where CELO is
        //    both native and an ERC-20) the delta is exactly what `receive` accepted. Failure is tolerated on
        //    purpose (a payer that cannot receive native must not block its own payment); the dust then stays.
        uint256 nativeAfter = address(this).balance;
        if (nativeAfter > nativeBefore) {
            unchecked {
                _sendNativeNoRevert(payer, nativeAfter - nativeBefore);
            }
        }
    }

    function _settle(Invoice calldata inv, address payer, address tokenOut, uint256 outBefore) private {
        // 6. Aggregate output check.
        uint256 got = IERC20Minimal(tokenOut).balanceOf(address(this)) - outBefore;
        uint256 want = inv.amountOut;
        if (got < want) revert InsufficientOutput(got, want);

        // 7. Pay the merchant exactly `want` (verified by the merchant's balance delta, so a fee-on-transfer
        //    or otherwise short-delivering tokenOut reverts instead of underpaying), surplus back to the payer.
        address merchant = inv.merchant;
        uint256 merchantBefore = IERC20Minimal(tokenOut).balanceOf(merchant);
        tokenOut.safeTransfer(merchant, want);
        uint256 received = IERC20Minimal(tokenOut).balanceOf(merchant) - merchantBefore;
        if (received != want) revert InsufficientOutput(received, want);

        unchecked {
            uint256 surplus = got - want;
            if (surplus != 0) tokenOut.safeTransfer(payer, surplus);
        }

        emit Paid(inv.id, payer, merchant, tokenOut, want);
    }

    /// @dev Pulls one leg into the router and, if needed, converts it to `tokenOut` (output lands in the router).
    ///      Any unconverted residue of `leg.token` (Uniswap partial fill at the price limit, or Textile orders
    ///      needing less than `amountIn`) is refunded to the payer, so the router's `leg.token` balance is back to
    ///      its pre-leg value.
    function _processLeg(
        Leg calldata leg,
        uint256 index,
        address payer,
        address tokenOut,
        bytes32 witness,
        bytes32 digest
    ) private {
        // Select the venue and validate it before pulling anything.
        (uint256 venue, IUniswapXReactor.SignedOrder[] memory orders) = _selectVenue(leg, tokenOut);

        uint256 balBefore = IERC20Minimal(leg.token).balanceOf(address(this));
        _pull(leg, index, payer, witness, digest);

        // Direct legs are counted by the aggregate tokenOut delta in pay().
        if (venue != VENUE_DIRECT) _convert(leg, venue, orders, balBefore, payer);
    }

    /// @dev empty path: direct (token must be tokenOut); "TXF1" prefix: Textile; anything else: Uniswap V3 path.
    function _selectVenue(Leg calldata leg, address tokenOut)
        private
        view
        returns (uint256 venue, IUniswapXReactor.SignedOrder[] memory orders)
    {
        address token = leg.token;
        if (token == tokenOut) {
            if (leg.path.length != 0) revert InvalidPath();
        } else if (_isTextileVenue(leg.path)) {
            orders = _decodeTextileOrders(leg.path, token, tokenOut);
            venue = VENUE_TEXTILE;
        } else {
            _validatePath(leg.path, token, tokenOut);
            venue = VENUE_UNISWAP;
        }
    }

    /// @dev Converts exactly the received delta of `leg.token`, then refunds the residue to the payer.
    function _convert(
        Leg calldata leg,
        uint256 venue,
        IUniswapXReactor.SignedOrder[] memory orders,
        uint256 balBefore,
        address payer
    ) private {
        address token = leg.token;
        uint256 received = IERC20Minimal(token).balanceOf(address(this)) - balBefore;

        if (venue == VENUE_UNISWAP) _swapUniswap(leg.path, token, received);
        else _fillTextile(orders, token, received);

        uint256 balAfter = IERC20Minimal(token).balanceOf(address(this));
        if (balAfter > balBefore) {
            unchecked {
                token.safeTransfer(payer, balAfter - balBefore);
            }
        }
    }

    function _swapUniswap(bytes calldata path, address token, uint256 amount) private {
        address swapRouter = SWAP_ROUTER;
        token.safeApprove(swapRouter, amount);
        ISwapRouter02(swapRouter)
            .exactInput(
                ISwapRouter02.ExactInputParams({
                    path: path,
                    recipient: address(this),
                    amountIn: amount,
                    amountOutMinimum: 0 // aggregate InsufficientOutput check protects the merchant
                })
            );
        token.safeApprove(swapRouter, 0);
    }

    /// @dev The reactor moves each maker's input (`tokenOut`) to this router, calls `reactorCallback`, then pulls
    ///      every output and protocol fee (`token`) from this router via transferFrom. The allowance caps that pull
    ///      at the delta actually received for this leg and is reset to 0 right after.
    function _fillTextile(IUniswapXReactor.SignedOrder[] memory orders, address token, uint256 amount) private {
        address reactor = TEXTILE_REACTOR;
        token.safeApprove(reactor, amount);
        _inTextileFill = true;
        IUniswapXReactor(reactor).executeBatchWithCallback(orders, "");
        _inTextileFill = false;
        token.safeApprove(reactor, 0);
    }

    /// @inheritdoc IReactorCallback
    /// @dev The reactor has already moved the makers' inputs here and pulls the outputs from the allowance set in
    ///      `_fillTextile`, so there is nothing to do. `view`: it cannot move funds or touch state.
    function reactorCallback(IUniswapXReactor.ResolvedOrder[] calldata, bytes calldata) external view {
        if (msg.sender != TEXTILE_REACTOR || !_inTextileFill) revert UnauthorizedCallback();
    }

    /// @dev BaseReactor._fill sends its whole native balance to the filler; refusing it would let anyone block every
    ///      Textile leg by leaving 1 wei in the reactor. Only accepted from the reactor during our own fill.
    receive() external payable {
        if (msg.sender != TEXTILE_REACTOR || !_inTextileFill) revert UnauthorizedCallback();
    }

    function _pull(Leg calldata leg, uint256 index, address payer, bytes32 witness, bytes32 digest) private {
        PullKind kind = leg.kind;
        if (kind == PullKind.EIP3009) {
            _pullEip3009(leg.token, leg.amountIn, leg.pullData, payer, _legNonce(digest, index));
        } else if (kind == PullKind.PERMIT2) {
            (uint256 nonce, uint256 deadline, bytes memory signature) =
                abi.decode(leg.pullData, (uint256, uint256, bytes));
            ISignatureTransfer(PERMIT2)
                .permitWitnessTransferFrom(
                    ISignatureTransfer.PermitTransferFrom({
                        permitted: ISignatureTransfer.TokenPermissions({token: leg.token, amount: leg.amountIn}),
                        nonce: nonce,
                        deadline: deadline
                    }),
                    ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: leg.amountIn}),
                    payer,
                    witness,
                    PERMIT2_WITNESS_TYPE_STRING,
                    signature
                );
        } else {
            // ALLOWANCE
            if (msg.sender != payer) revert PayerMustBeSender();
            leg.token.safeTransferFrom(payer, address(this), leg.amountIn);
        }
    }

    /// @dev The nonce is recomputed here (never taken from the relayer), so the token authorization is only
    ///      consumable for this exact intent and leg index.
    function _pullEip3009(address token, uint256 amount, bytes calldata pullData, address payer, bytes32 nonce)
        private
    {
        (uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s) =
            abi.decode(pullData, (uint256, uint256, uint8, bytes32, bytes32));
        IERC3009(token).receiveWithAuthorization(payer, address(this), amount, validAfter, validBefore, nonce, v, r, s);
    }

    /// @dev path = tokenIn(20) | (fee(3) | token(20)) × hops, 1 <= hops <= MAX_HOPS,
    ///      first token == leg.token, last token == tokenOut.
    function _validatePath(bytes calldata path, address tokenIn, address tokenOut) private pure {
        uint256 len = path.length;
        if (len < ADDR_SIZE + HOP_SIZE || (len - ADDR_SIZE) % HOP_SIZE != 0 || (len - ADDR_SIZE) / HOP_SIZE > MAX_HOPS)
        {
            revert InvalidPath();
        }
        if (address(bytes20(path[:ADDR_SIZE])) != tokenIn) revert InvalidPath();
        if (address(bytes20(path[len - ADDR_SIZE:])) != tokenOut) revert InvalidPath();
    }

    /// @dev Same rule as `isTextileVenue` in packages/shared/src/textile-venue.ts: more than 4 bytes, "TXF1" prefix.
    function _isTextileVenue(bytes calldata path) internal pure returns (bool) {
        return path.length > MAGIC_SIZE && bytes4(path[:MAGIC_SIZE]) == TEXTILE_MAGIC;
    }

    /// @dev Decodes `path[4:]` as `SignedOrder[]` (malformed encoding reverts in the ABI decoder) and checks each
    ///      LimitOrder: targets TEXTILE_REACTOR, sells `tokenOut`, and only asks for `tokenIn`. Amounts, recipients,
    ///      deadlines, nonces and signatures are enforced by the reactor and Permit2; the allowance and the
    ///      aggregate output check bound what the orders can cost the payer or the merchant.
    function _decodeTextileOrders(bytes calldata path, address tokenIn, address tokenOut)
        internal
        view
        returns (IUniswapXReactor.SignedOrder[] memory orders)
    {
        orders = abi.decode(path[MAGIC_SIZE:], (IUniswapXReactor.SignedOrder[]));
        uint256 n = orders.length;
        if (n == 0) revert InvalidTextileOrder();
        address reactor = TEXTILE_REACTOR;
        for (uint256 i; i < n; ++i) {
            IUniswapXReactor.LimitOrder memory o = abi.decode(orders[i].order, (IUniswapXReactor.LimitOrder));
            if (o.info.reactor != reactor || o.input.token != tokenOut) revert InvalidTextileOrder();
            uint256 m = o.outputs.length;
            for (uint256 j; j < m; ++j) {
                if (o.outputs[j].token != tokenIn) revert InvalidTextileOrder();
            }
        }
    }

    function _sendNativeNoRevert(address to, uint256 amount) private {
        assembly ("memory-safe") {
            pop(call(gas(), to, amount, 0, 0, 0, 0))
        }
    }

    // ───────────────────────────── Hashing (views, identical to v1) ─────────────────────────────

    /// @inheritdoc ICobraRouter
    function hashInvoice(Invoice calldata inv) external pure returns (bytes32) {
        return _hashInvoice(inv);
    }

    /// @inheritdoc ICobraRouter
    function hashIntent(Invoice calldata inv, address payer, Leg[] calldata legs) external pure returns (bytes32) {
        return _hashIntent(inv, payer, legs);
    }

    /// @inheritdoc ICobraRouter
    function intentDigest(Invoice calldata inv, address payer, Leg[] calldata legs) external view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), _hashIntent(inv, payer, legs)));
    }

    /// @inheritdoc ICobraRouter
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _CACHED_CHAIN_ID ? _CACHED_DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function _hashInvoice(Invoice calldata inv) internal pure returns (bytes32) {
        return keccak256(abi.encode(INVOICE_TYPEHASH, inv.id, inv.merchant, inv.tokenOut, inv.amountOut, inv.deadline));
    }

    function _hashIntent(Invoice calldata inv, address payer, Leg[] calldata legs) internal pure returns (bytes32) {
        bytes32[] memory legHashes = new bytes32[](legs.length);
        for (uint256 i; i < legs.length; ++i) {
            Leg calldata leg = legs[i];
            legHashes[i] = keccak256(
                abi.encode(LEG_COMMITMENT_TYPEHASH, leg.token, leg.amountIn, uint8(leg.kind), keccak256(leg.path))
            );
        }
        return keccak256(
            abi.encode(PAYMENT_INTENT_TYPEHASH, _hashInvoice(inv), payer, keccak256(abi.encodePacked(legHashes)))
        );
    }

    /// @dev keccak256(abi.encode(bytes32 digest, uint256 i)) — EIP-3009 nonce (and recommended Permit2 nonce).
    function _legNonce(bytes32 digest, uint256 index) internal pure returns (bytes32) {
        return keccak256(abi.encode(digest, index));
    }
}
