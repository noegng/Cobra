// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICobraRouter} from "./ICobraRouter.sol";

/// @title ICobraRouterV2: ICobraRouter + Textile FX RFQ venue (docs/interfaces.md §7)
/// @notice Same `pay`, structs, events, errors and EIP-712 scheme as v1. A leg whose `path` starts with "TXF1"
///         settles through Textile's UniswapX LimitOrderReactor.
interface ICobraRouterV2 is ICobraRouter {
    function TEXTILE_REACTOR() external view returns (address);
}
