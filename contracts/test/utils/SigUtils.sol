// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ICobraRouter} from "../../src/ICobraRouter.sol";

interface IDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Off-chain-signer emulation for tests: builds EIP-3009 and Permit2 pullData exactly as the payer's wallet
///         would (mirrors packages/shared/src/eip712.ts eip3009TypedData / permit2TypedData). Anvil keys only.
abstract contract SigUtils is Test {
    bytes32 internal constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    /// @dev Copy of TYPE_STRINGS.PERMIT2_WITNESS (TS), kept independent from the router's constant on purpose.
    string internal constant WITNESS_TYPE_STRING = "PaymentIntent witness)"
        "Invoice(bytes32 id,address merchant,address tokenOut,uint256 amountOut,uint256 deadline)"
        "LegCommitment(address token,uint256 amountIn,uint8 kind,bytes32 pathHash)"
        "PaymentIntent(Invoice invoice,address payer,LegCommitment[] legs)"
        "TokenPermissions(address token,uint256 amount)";

    // anvil #0 / #1 public test keys
    uint256 internal constant PAYER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant OTHER_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    function _legNonce(bytes32 digest, uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode(digest, i));
    }

    function _eip3009PullData(
        uint256 pk,
        address token,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash =
            keccak256(abi.encode(RWA_TYPEHASH, vm.addr(pk), to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IDomain(token).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encode(validAfter, validBefore, v, r, s);
    }

    function _permit2PullData(
        uint256 pk,
        address permit2,
        address token,
        uint256 amount,
        address spender,
        uint256 nonce,
        uint256 deadline,
        bytes32 witness
    ) internal view returns (bytes memory) {
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                WITNESS_TYPE_STRING
            )
        );
        bytes32 dataHash = keccak256(
            abi.encode(
                typeHash,
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, token, amount)),
                spender,
                nonce,
                deadline,
                witness
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IDomain(permit2).DOMAIN_SEPARATOR(), dataHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encode(nonce, deadline, abi.encodePacked(r, s, v));
    }

    /// @notice Fills pullData for every leg as the payer `pk` would sign it for `router`.
    ///         EIP-3009 window: (0, inv.deadline + 1); Permit2: nonce = uint256(legNonce), deadline = inv.deadline.
    function _sign(ICobraRouter router, uint256 pk, ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs)
        internal
        view
    {
        address payer = vm.addr(pk);
        bytes32 digest = router.intentDigest(inv, payer, legs);
        bytes32 witness = router.hashIntent(inv, payer, legs);
        for (uint256 i; i < legs.length; ++i) {
            ICobraRouter.Leg memory leg = legs[i];
            if (leg.kind == ICobraRouter.PullKind.EIP3009) {
                leg.pullData = _eip3009PullData(
                    pk, leg.token, address(router), leg.amountIn, 0, inv.deadline + 1, _legNonce(digest, i)
                );
            } else if (leg.kind == ICobraRouter.PullKind.PERMIT2) {
                leg.pullData = _permit2PullData(
                    pk,
                    router.PERMIT2(),
                    leg.token,
                    leg.amountIn,
                    address(router),
                    uint256(_legNonce(digest, i)),
                    inv.deadline,
                    witness
                );
            } else {
                leg.pullData = "";
            }
        }
    }

    function _path(address a, uint24 fee, address b) internal pure returns (bytes memory) {
        return abi.encodePacked(a, fee, b);
    }

    function _path(address a, uint24 f1, address b, uint24 f2, address c) internal pure returns (bytes memory) {
        return abi.encodePacked(a, f1, b, f2, c);
    }

    function _leg(address token, uint256 amountIn, ICobraRouter.PullKind kind, bytes memory path)
        internal
        pure
        returns (ICobraRouter.Leg memory)
    {
        return ICobraRouter.Leg({token: token, amountIn: amountIn, kind: kind, pullData: "", path: path});
    }

    function _legs1(ICobraRouter.Leg memory a) internal pure returns (ICobraRouter.Leg[] memory l) {
        l = new ICobraRouter.Leg[](1);
        l[0] = a;
    }

    function _legs2(ICobraRouter.Leg memory a, ICobraRouter.Leg memory b)
        internal
        pure
        returns (ICobraRouter.Leg[] memory l)
    {
        l = new ICobraRouter.Leg[](2);
        l[0] = a;
        l[1] = b;
    }

    function _legs3(ICobraRouter.Leg memory a, ICobraRouter.Leg memory b, ICobraRouter.Leg memory c)
        internal
        pure
        returns (ICobraRouter.Leg[] memory l)
    {
        l = new ICobraRouter.Leg[](3);
        l[0] = a;
        l[1] = b;
        l[2] = c;
    }
}
