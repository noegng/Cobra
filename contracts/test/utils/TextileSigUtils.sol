// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SigUtils} from "./SigUtils.sol";
import {LimitOrder, LimitOrderLib} from "../vendor/textile-uniswapx/uniswapx/lib/LimitOrderLib.sol";
import {
    OrderInfo,
    InputToken,
    OutputToken,
    SignedOrder
} from "../vendor/textile-uniswapx/uniswapx/base/ReactorStructs.sol";
import {IReactor} from "../vendor/textile-uniswapx/uniswapx/interfaces/IReactor.sol";
import {IValidationCallback} from "../vendor/textile-uniswapx/uniswapx/interfaces/IValidationCallback.sol";
import {ERC20} from "../vendor/textile-uniswapx/solmate/src/tokens/ERC20.sol";

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Emulates a Textile maker: builds UniswapX LimitOrders and signs them as Permit2 witness transfers
///         (spender = reactor, witness = LimitOrder hash, type string = LimitOrderLib.PERMIT2_ORDER_TYPE), exactly
///         what LimitOrderReactor._transferInputTokens verifies. Forge/anvil public test keys only.
abstract contract TextileSigUtils is SigUtils {
    using LimitOrderLib for LimitOrder;

    bytes4 internal constant TXF1 = 0x54584631;
    // anvil #2 / #3 public test keys (makers)
    uint256 internal constant MAKER_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 internal constant MAKER2_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    function _limitOrder(
        address reactor,
        address swapper,
        uint256 nonce,
        uint256 deadline,
        address inputToken,
        uint256 inputAmount,
        address outputToken,
        uint256 outputAmount
    ) internal pure returns (LimitOrder memory o) {
        o.info = OrderInfo({
            reactor: IReactor(reactor),
            swapper: swapper,
            nonce: nonce,
            deadline: deadline,
            additionalValidationContract: IValidationCallback(address(0)),
            additionalValidationData: ""
        });
        o.input = InputToken({token: ERC20(inputToken), amount: inputAmount, maxAmount: inputAmount});
        o.outputs = new OutputToken[](1);
        o.outputs[0] = OutputToken({token: outputToken, amount: outputAmount, recipient: swapper});
    }

    function _permit2OrderDigest(address permit2, address reactor, LimitOrder memory o)
        internal
        view
        returns (bytes32)
    {
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                LimitOrderLib.PERMIT2_ORDER_TYPE
            )
        );
        bytes32 tp = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, address(o.input.token), o.input.maxAmount));
        bytes32 dataHash = keccak256(abi.encode(typeHash, tp, reactor, o.info.nonce, o.info.deadline, o.hash()));
        return keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(permit2).DOMAIN_SEPARATOR(), dataHash));
    }

    function _signOrder(uint256 pk, address permit2, LimitOrder memory o) internal view returns (SignedOrder memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _permit2OrderDigest(permit2, address(o.info.reactor), o));
        return SignedOrder({order: abi.encode(o), sig: abi.encodePacked(r, s, v)});
    }

    /// @dev Same bytes as encodeTextileVenue (packages/shared/src/textile-venue.ts).
    function _textilePath(SignedOrder[] memory orders) internal pure returns (bytes memory) {
        return abi.encodePacked(TXF1, abi.encode(orders));
    }

    function _textilePath(SignedOrder memory a) internal pure returns (bytes memory) {
        return _textilePath(_orders1(a));
    }

    function _orders1(SignedOrder memory a) internal pure returns (SignedOrder[] memory l) {
        l = new SignedOrder[](1);
        l[0] = a;
    }

    function _orders2(SignedOrder memory a, SignedOrder memory b) internal pure returns (SignedOrder[] memory l) {
        l = new SignedOrder[](2);
        l[0] = a;
        l[1] = b;
    }

    /// @dev Exact-output Textile pricing: maker output + protocol fee (floor(out * bps / 10_000), per token).
    function _withFee(uint256 out, uint256 bps) internal pure returns (uint256) {
        return out + out * bps / 10_000;
    }
}
