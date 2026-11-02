// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CobraRouter} from "../src/CobraRouter.sol";

interface IFactoryGetter {
    function factory() external view returns (address);
}

/// @notice Deploys the immutable CobraRouter.
///         Env: PERMIT2, SWAP_ROUTER (Celo: 0x000000000022D473030F116dDEE9F6B43aC78BA3 /
///         0x5615CDAb10dc425a742d643d949a7F474C01abc4, see docs/research/onchain-verification.md).
///         AGENTS: dry-run only (no --broadcast). The human broadcasts with their own signer, see SECURITY.md.
contract Deploy is Script {
    function run() external returns (CobraRouter router) {
        address permit2 = vm.envAddress("PERMIT2");
        address swapRouter = vm.envAddress("SWAP_ROUTER");

        require(permit2.code.length > 0, "PERMIT2 has no code on this chain");
        require(swapRouter.code.length > 0, "SWAP_ROUTER has no code on this chain");
        // SwapRouter02 exposes factory(); a wrong address usually fails here.
        address factory = IFactoryGetter(swapRouter).factory();

        console2.log("chainId     ", block.chainid);
        console2.log("PERMIT2     ", permit2);
        console2.log("SWAP_ROUTER ", swapRouter);
        console2.log("V3 factory  ", factory);

        vm.startBroadcast();
        router = new CobraRouter(permit2, swapRouter);
        vm.stopBroadcast();

        require(router.PERMIT2() == permit2 && router.SWAP_ROUTER() == swapRouter, "immutables mismatch");
        console2.log("CobraRouter ", address(router));
        console2.logBytes32(router.DOMAIN_SEPARATOR());
    }
}
