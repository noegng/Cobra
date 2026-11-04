// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ICobraRouter} from "../src/ICobraRouter.sol";
import {ICobraRouterV2} from "../src/ICobraRouterV2.sol";
import {IReactorCallback} from "../src/interfaces/IUniswapXReactor.sol";

/// @notice Forge-side ABI guard (the authoritative check is packages/shared/test/abi-parity.test.ts):
///         CobraRouter must expose exactly ICobraRouter's 8 functions, 1 event and 6 errors — nothing more.
contract AbiParityTest is Test {
    function test_routerAbiEqualsInterface() public view {
        string memory art = vm.readFile(string.concat(vm.projectRoot(), "/out/CobraRouter.sol/CobraRouter.json"));

        bytes4[8] memory expected = [
            ICobraRouter.pay.selector,
            ICobraRouter.isPaid.selector,
            ICobraRouter.hashInvoice.selector,
            ICobraRouter.hashIntent.selector,
            ICobraRouter.intentDigest.selector,
            ICobraRouter.DOMAIN_SEPARATOR.selector,
            ICobraRouter.PERMIT2.selector,
            ICobraRouter.SWAP_ROUTER.selector
        ];
        string[] memory sigs = vm.parseJsonKeys(art, ".methodIdentifiers");
        assertEq(sigs.length, expected.length, "function count");
        for (uint256 i; i < sigs.length; ++i) {
            bytes4 sel = bytes4(keccak256(bytes(sigs[i])));
            bool found;
            for (uint256 j; j < expected.length; ++j) {
                if (expected[j] == sel) found = true;
            }
            assertTrue(found, sigs[i]);
        }

        uint256 events;
        uint256 errors;
        uint256 functions;
        for (uint256 i; vm.keyExistsJson(art, string.concat(".abi[", vm.toString(i), "]")); ++i) {
            bytes32 t = keccak256(bytes(vm.parseJsonString(art, string.concat(".abi[", vm.toString(i), "].type"))));
            if (t == keccak256("event")) events++;
            else if (t == keccak256("error")) errors++;
            else if (t == keccak256("function")) functions++;
            else assertEq(t, keccak256("constructor"), "unexpected ABI item (receive/fallback?)");
        }
        assertEq(functions, 8, "functions");
        assertEq(events, 1, "events");
        assertEq(errors, 6, "errors");
    }

    /// @notice CobraRouterV2 = ICobraRouter (unchanged) + TEXTILE_REACTOR + reactorCallback + 2 v2-only errors
    ///         + a guarded `receive` (needed because UniswapX reactors refund native to the filler). No fallback.
    function test_routerV2AbiEqualsInterfacePlusVenue() public view {
        string memory art = vm.readFile(string.concat(vm.projectRoot(), "/out/CobraRouterV2.sol/CobraRouterV2.json"));
        bytes4[10] memory expected = [
            ICobraRouter.pay.selector,
            ICobraRouter.isPaid.selector,
            ICobraRouter.hashInvoice.selector,
            ICobraRouter.hashIntent.selector,
            ICobraRouter.intentDigest.selector,
            ICobraRouter.DOMAIN_SEPARATOR.selector,
            ICobraRouter.PERMIT2.selector,
            ICobraRouter.SWAP_ROUTER.selector,
            ICobraRouterV2.TEXTILE_REACTOR.selector,
            IReactorCallback.reactorCallback.selector
        ];
        assertEq(IReactorCallback.reactorCallback.selector, bytes4(0x585da628), "UniswapX IReactorCallback selector");
        string[] memory sigs = vm.parseJsonKeys(art, ".methodIdentifiers");
        assertEq(sigs.length, expected.length, "function count");
        for (uint256 i; i < sigs.length; ++i) {
            bytes4 sel = bytes4(keccak256(bytes(sigs[i])));
            bool found;
            for (uint256 j; j < expected.length; ++j) {
                if (expected[j] == sel) found = true;
            }
            assertTrue(found, sigs[i]);
        }
        uint256 events;
        uint256 errors;
        uint256 functions;
        uint256 receives;
        for (uint256 i; vm.keyExistsJson(art, string.concat(".abi[", vm.toString(i), "]")); ++i) {
            bytes32 t = keccak256(bytes(vm.parseJsonString(art, string.concat(".abi[", vm.toString(i), "].type"))));
            if (t == keccak256("event")) events++;
            else if (t == keccak256("error")) errors++;
            else if (t == keccak256("function")) functions++;
            else if (t == keccak256("receive")) receives++;
            else assertEq(t, keccak256("constructor"), "unexpected ABI item (fallback?)");
        }
        assertEq(functions, 10, "functions");
        assertEq(events, 1, "events");
        assertEq(errors, 8, "errors (6 frozen + InvalidTextileOrder + UnauthorizedCallback)");
        assertEq(receives, 1, "receive");
    }
}
