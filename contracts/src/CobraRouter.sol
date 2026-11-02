// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICobraRouter} from "./ICobraRouter.sol";
import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";

/// @title CobraRouter
/// @notice Immutable, ownerless checkout router. Pulls a payer's tokens (EIP-3009 / Permit2 witness / allowance),
///         swaps them on Uniswap V3 (SwapRouter02) and pays a merchant EXACTLY `inv.amountOut` of `inv.tokenOut`,
///         refunding any surplus to the payer — or reverts entirely. See docs/interfaces.md §2–§3.
/// @dev No owner, no upgrade, no fees, no pause, no receive/fallback. Holds no funds between calls.
///      Revert reasons outside ICobraRouter's custom errors are short strings on purpose: any extra custom error
///      would appear in the ABI, which must equal packages/shared/src/abi.ts exactly.
contract CobraRouter is ICobraRouter {
    using SafeTransfer for address;

    // ───────────────────────────── EIP-712 ─────────────────────────────

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

    // ───────────────────────────── Limits ─────────────────────────────

    uint256 internal constant MAX_LEGS = 3;
    /// @dev Uniswap V3 path: token(20) | fee(3) | token(20) …  Capped at 4 hops (gas-griefing bound).
    uint256 internal constant ADDR_SIZE = 20;
    uint256 internal constant HOP_SIZE = 23;
    uint256 internal constant MAX_HOPS = 4;

    // ───────────────────────────── State ─────────────────────────────

    address public immutable PERMIT2;
    address public immutable SWAP_ROUTER;

    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;

    /// @inheritdoc ICobraRouter
    mapping(bytes32 invoiceHash => bool) public isPaid;

    /// @dev Reentrancy lock in transient storage (EIP-1153). TSTORE/TLOAD verified on Celo mainnet via eth_call.
    bool private transient _locked;

    constructor(address permit2, address swapRouter) {
        require(permit2 != address(0) && swapRouter != address(0), "ZERO_ADDRESS");
        PERMIT2 = permit2;
        SWAP_ROUTER = swapRouter;
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

        // 4–5. Pull every leg, swap when needed.
        for (uint256 i; i < legs.length; ++i) {
            _processLeg(legs[i], i, payer, tokenOut, witness, digest);
        }

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

        // 8.
        emit Paid(inv.id, payer, merchant, tokenOut, want);
    }

    /// @dev Pulls one leg into the router and, if needed, swaps it to `tokenOut` (output lands in the router).
    ///      Any unswapped residue of `leg.token` (partial fill at the pool's price limit) is refunded to the payer,
    ///      so the router's balance of `leg.token` is back to its pre-leg value.
    function _processLeg(
        Leg calldata leg,
        uint256 index,
        address payer,
        address tokenOut,
        bytes32 witness,
        bytes32 digest
    ) private {
        address token = leg.token;
        bool direct = token == tokenOut;

        // Validate the path before pulling anything.
        if (direct) {
            if (leg.path.length != 0) revert InvalidPath();
        } else {
            _validatePath(leg.path, token, tokenOut);
        }

        uint256 balBefore = IERC20Minimal(token).balanceOf(address(this));
        _pull(leg, index, payer, witness, digest);
        uint256 received = IERC20Minimal(token).balanceOf(address(this)) - balBefore;

        if (direct) return; // counted by the aggregate tokenOut delta in pay()

        address swapRouter = SWAP_ROUTER;
        token.safeApprove(swapRouter, received);
        ISwapRouter02(swapRouter).exactInput(
            ISwapRouter02.ExactInputParams({
                path: leg.path,
                recipient: address(this),
                amountIn: received,
                amountOutMinimum: 0 // aggregate InsufficientOutput check protects the merchant
            })
        );
        token.safeApprove(swapRouter, 0);

        uint256 balAfter = IERC20Minimal(token).balanceOf(address(this));
        if (balAfter > balBefore) {
            unchecked {
                token.safeTransfer(payer, balAfter - balBefore);
            }
        }
    }

    function _pull(Leg calldata leg, uint256 index, address payer, bytes32 witness, bytes32 digest) private {
        PullKind kind = leg.kind;
        if (kind == PullKind.EIP3009) {
            _pullEip3009(leg.token, leg.amountIn, leg.pullData, payer, _legNonce(digest, index));
        } else if (kind == PullKind.PERMIT2) {
            (uint256 nonce, uint256 deadline, bytes memory signature) =
                abi.decode(leg.pullData, (uint256, uint256, bytes));
            ISignatureTransfer(PERMIT2).permitWitnessTransferFrom(
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
        if (len < ADDR_SIZE + HOP_SIZE || (len - ADDR_SIZE) % HOP_SIZE != 0 || (len - ADDR_SIZE) / HOP_SIZE > MAX_HOPS) {
            revert InvalidPath();
        }
        if (address(bytes20(path[:ADDR_SIZE])) != tokenIn) revert InvalidPath();
        if (address(bytes20(path[len - ADDR_SIZE:])) != tokenOut) revert InvalidPath();
    }

    // ───────────────────────────── Hashing (views) ─────────────────────────────

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
