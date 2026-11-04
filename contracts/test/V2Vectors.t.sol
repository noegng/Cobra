// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICobraRouter} from "../src/ICobraRouter.sol";
import {IUniswapXReactor} from "../src/interfaces/IUniswapXReactor.sol";
import {VectorsTest} from "./Vectors.t.sol";
import {CobraRouterHarness} from "./utils/CobraRouterHarness.sol";
import {CobraRouterV2Harness} from "./utils/CobraRouterV2Harness.sol";

/// @notice v2 parity with packages/shared:
///         1. every case of test/vectors/eip712.json (inherited from VectorsTest) holds for CobraRouterV2 deployed at
///            the vector's router address: same type strings, struct hashes, digests and leg nonces as v1;
///         2. v1 and v2 differ only by `verifyingContract` in the domain;
///         3. the Textile venue path codec matches encodeTextileVenue byte for byte (test/vectors/textile-venue.json).
contract V2VectorsTest is VectorsTest {
    function _deployHarness(address at) internal override {
        deployCodeTo(
            "CobraRouterV2Harness.sol:CobraRouterV2Harness",
            abi.encode(address(0xbeef1), address(0xbeef2), address(0xbeef3)),
            at
        );
    }

    function test_v2_isV2Harness() public view {
        assertEq(CobraRouterV2Harness(payable(address(router))).TEXTILE_REACTOR(), address(0xbeef3));
    }

    function test_v2_domainSeparationFromV1_isVerifyingContractOnly() public {
        CobraRouterHarness v1 = new CobraRouterHarness(address(0xbeef1), address(0xbeef2));
        CobraRouterV2Harness v2 = new CobraRouterV2Harness(address(0xbeef1), address(0xbeef2), address(0xbeef3));
        ICobraRouter.Invoice memory inv = _invoice();
        address payer = vm.parseJsonAddress(json, ".payer");
        ICobraRouter.Leg[] memory legs = new ICobraRouter.Leg[](1);
        legs[0].token = vm.parseJsonAddress(json, ".cases[1].legs[0].token");
        legs[0].amountIn = vm.parseJsonUint(json, ".cases[1].legs[0].amountIn");
        legs[0].kind = ICobraRouter.PullKind(vm.parseJsonUint(json, ".cases[1].legs[0].kind"));
        legs[0].path = vm.parseJsonBytes(json, ".cases[1].legs[0].path");

        bytes32 h = v1.hashIntent(inv, payer, legs);
        assertEq(v2.hashIntent(inv, payer, legs), h, "struct hash identical");
        assertEq(v2.hashInvoice(inv), v1.hashInvoice(inv), "invoice hash identical");
        assertEq(v2.intentDigest(inv, payer, legs), keccak256(abi.encodePacked("\x19\x01", _domain(address(v2)), h)));
        assertEq(v1.intentDigest(inv, payer, legs), keccak256(abi.encodePacked("\x19\x01", _domain(address(v1)), h)));
        assertTrue(v1.intentDigest(inv, payer, legs) != v2.intentDigest(inv, payer, legs), "digests differ");
    }

    function test_v2_textileCodecParity() public {
        string memory tj = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/textile-venue.json"));
        address reactor = vm.parseJsonAddress(tj, ".reactor");
        address tokenIn = vm.parseJsonAddress(tj, ".tokenIn");
        address tokenOut = vm.parseJsonAddress(tj, ".tokenOut");
        bytes memory path = vm.parseJsonBytes(tj, ".path");
        assertEq(keccak256(path), vm.parseJsonBytes32(tj, ".pathHash"), "pathHash");

        uint256 n;
        while (vm.keyExistsJson(tj, string.concat(".orders[", vm.toString(n), "]"))) ++n;
        assertEq(n, 2);
        IUniswapXReactor.SignedOrder[] memory orders = new IUniswapXReactor.SignedOrder[](n);
        for (uint256 i; i < n; ++i) {
            string memory b = string.concat(".orders[", vm.toString(i), "]");
            orders[i].order = vm.parseJsonBytes(tj, string.concat(b, ".order"));
            orders[i].sig = vm.parseJsonBytes(tj, string.concat(b, ".sig"));
        }
        // Solidity encoding == TS encodeTextileVenue
        assertEq(abi.encodePacked(bytes4(0x54584631), abi.encode(orders)), path, "encode parity");

        // The router's own decoder reads exactly the TS orders and accepts them (reactor / tokens checks pass).
        CobraRouterV2Harness v2 = new CobraRouterV2Harness(address(0xbeef1), address(0xbeef2), reactor);
        assertTrue(v2.exposed_isTextileVenue(path));
        IUniswapXReactor.SignedOrder[] memory got = v2.exposed_decodeTextileOrders(path, tokenIn, tokenOut);
        assertEq(got.length, n);
        for (uint256 i; i < n; ++i) {
            assertEq(got[i].order, orders[i].order, "order bytes");
            assertEq(got[i].sig, orders[i].sig, "sig bytes");
            IUniswapXReactor.LimitOrder memory o = abi.decode(got[i].order, (IUniswapXReactor.LimitOrder));
            assertEq(o.info.reactor, reactor);
            assertEq(o.input.token, tokenOut);
        }
        // Second order carries Textile's PreferredFillerValidation data with the v2 router as the only filler.
        IUniswapXReactor.LimitOrder memory o2 = abi.decode(got[1].order, (IUniswapXReactor.LimitOrder));
        (address[] memory fillers, uint256 until) = abi.decode(o2.info.additionalValidationData, (address[], uint256));
        assertEq(fillers.length, 1);
        assertEq(fillers[0], address(0xc0b4A002));
        assertEq(until, 1_800_000_120);
        assertEq(o2.outputs.length, 2);

        // Same rule as isTextileVenue (TS): > 4 bytes and the magic prefix.
        assertFalse(v2.exposed_isTextileVenue(hex"54584631"));
        assertFalse(v2.exposed_isTextileVenue(""));
        assertFalse(v2.exposed_isTextileVenue(abi.encodePacked(tokenIn, uint24(100), tokenOut)));

        // Decoding with the wrong tokens or reactor is refused.
        vm.expectRevert(bytes4(keccak256("InvalidTextileOrder()")));
        v2.exposed_decodeTextileOrders(path, tokenOut, tokenIn);
        CobraRouterV2Harness other = new CobraRouterV2Harness(address(0xbeef1), address(0xbeef2), address(0xbeef3));
        vm.expectRevert(bytes4(keccak256("InvalidTextileOrder()")));
        other.exposed_decodeTextileOrders(path, tokenIn, tokenOut);
    }

    function _domain(address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Cobra Router"),
                keccak256("1"),
                block.chainid,
                verifyingContract
            )
        );
    }
}
