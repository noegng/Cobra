// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";

interface IERC20Like {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Faithful re-implementation of Uniswap Permit2 SignatureTransfer.permitWitnessTransferFrom
///         (same domain, typehash construction, unordered nonce bitmap, 65-byte signatures). Unit tests only;
///         the fork suite runs against the real Permit2 on Celo.
contract MockPermit2 is ISignatureTransfer {
    bytes32 public constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    string public constant PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                block.chainid,
                address(this)
            )
        );
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external {
        require(block.timestamp <= permit.deadline, "SignatureExpired");
        require(transferDetails.requestedAmount <= permit.permitted.amount, "InvalidAmount");
        _useUnorderedNonce(owner, permit.nonce);
        _verify(_digest(permit, witness, witnessTypeString), owner, signature);
        require(
            IERC20Like(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount),
            "TRANSFER_FROM_FAILED"
        );
    }

    function _digest(PermitTransferFrom calldata permit, bytes32 witness, string calldata witnessTypeString)
        internal
        view
        returns (bytes32)
    {
        bytes32 typeHash = keccak256(abi.encodePacked(PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB, witnessTypeString));
        bytes32 tokenPermissionsHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted));
        bytes32 dataHash =
            keccak256(abi.encode(typeHash, tokenPermissionsHash, msg.sender, permit.nonce, permit.deadline, witness));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), dataHash));
    }

    function _verify(bytes32 digest, address owner, bytes calldata signature) internal pure {
        require(signature.length == 65, "InvalidSignatureLength");
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "InvalidSignature");
        require(signer == owner, "InvalidSigner");
    }

    function _useUnorderedNonce(address from, uint256 nonce) internal {
        uint256 wordPos = uint248(nonce >> 8);
        uint256 bitPos = uint8(nonce);
        uint256 bit = 1 << bitPos;
        uint256 flipped = nonceBitmap[from][wordPos] ^= bit;
        require(flipped & bit != 0, "InvalidNonce");
    }
}
