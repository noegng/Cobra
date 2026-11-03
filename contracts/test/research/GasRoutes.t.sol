// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICobraRouter} from "../../src/ICobraRouter.sol";
import {CobraRouter} from "../../src/CobraRouter.sol";
import {SigUtils} from "../utils/SigUtils.sol";

interface IT {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IQ {
    function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256, uint160[] memory, uint32[] memory, uint256);
}

/// @notice Plan 3 research: gas of CobraRouter.pay per route on a Celo fork (gasleft delta around the call).
///         Run: CELO_RPC_URL=https://forno.celo.org forge test --match-path test/research/GasRoutes.t.sol -vv
contract GasRoutesTest is SigUtils {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant SWAP = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;
    address constant QUOTER = 0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8;
    address constant USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C;
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant USAT = 0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771;
    address constant WARS = 0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D;
    address constant WBRL = 0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0;
    uint24 constant FEE = 100;

    CobraRouter router;
    address payer;
    address merchant = makeAddr("gas-merchant");
    address relayer = makeAddr("gas-relayer");
    bool forked;

    function setUp() public {
        try vm.createSelectFork(vm.envOr("CELO_RPC_URL", string("https://forno.celo.org"))) {
            forked = block.chainid == 42220;
        } catch {}
        if (!forked) return;
        router = new CobraRouter(PERMIT2, SWAP);
        payer = vm.addr(PAYER_PK);
        if (payer.code.length != 0) vm.etch(payer, "");
    }

    function _fund(address t, uint256 a) internal {
        deal(t, payer, a);
        vm.prank(payer);
        IT(t).approve(PERMIT2, type(uint256).max);
    }

    function _inv(uint256 out, address tokenOut, bytes32 salt) internal view returns (ICobraRouter.Invoice memory) {
        return ICobraRouter.Invoice(keccak256(abi.encode(salt, out)), merchant, tokenOut, out, block.timestamp + 30 minutes);
    }

    function _q(bytes memory p, uint256 a) internal returns (uint256 o) {
        (o,,,) = IQ(QUOTER).quoteExactInput(p, a);
    }

    function _run(string memory name, ICobraRouter.Invoice memory inv, ICobraRouter.Leg[] memory legs) internal {
        _sign(router, PAYER_PK, inv, legs);
        vm.prank(relayer);
        uint256 g = gasleft();
        router.pay(inv, payer, legs);
        g -= gasleft();
        emit log_named_uint(name, g);
    }

    function test_gas_1leg_usdt_3009_1hop() public {
        if (!forked) return;
        _fund(USDT, 1000e6);
        bytes memory p = _path(USDT, FEE, WARS);
        uint256 out = _q(p, 50e6) * 99 / 100;
        _run("GAS usdt->wARS 1leg EIP3009 1hop", _inv(out, WARS, "a"), _legs1(_leg(USDT, 50e6, ICobraRouter.PullKind.EIP3009, p)));
    }

    function test_gas_1leg_usdt_permit2_1hop() public {
        if (!forked) return;
        _fund(USDT, 1000e6);
        bytes memory p = _path(USDT, FEE, WARS);
        uint256 out = _q(p, 50e6) * 99 / 100;
        _run("GAS usdt->wARS 1leg PERMIT2 1hop", _inv(out, WARS, "b"), _legs1(_leg(USDT, 50e6, ICobraRouter.PullKind.PERMIT2, p)));
    }

    function test_gas_1leg_usdc_3009_2hops() public {
        if (!forked) return;
        _fund(USDC, 1000e6);
        bytes memory p = _path(USDC, FEE, USDT, FEE, WARS);
        uint256 out = _q(p, 50e6) * 99 / 100;
        _run("GAS usdc->usdt->wARS 1leg EIP3009 2hops", _inv(out, WARS, "c"), _legs1(_leg(USDC, 50e6, ICobraRouter.PullKind.EIP3009, p)));
    }

    function test_gas_1leg_usdc_permit2_2hops() public {
        if (!forked) return;
        _fund(USDC, 1000e6);
        bytes memory p = _path(USDC, FEE, USDT, FEE, WARS);
        uint256 out = _q(p, 50e6) * 99 / 100;
        _run("GAS usdc->usdt->wARS 1leg PERMIT2 2hops", _inv(out, WARS, "d"), _legs1(_leg(USDC, 50e6, ICobraRouter.PullKind.PERMIT2, p)));
    }

    function test_gas_2legs_usdc3009_usdtPermit2() public {
        if (!forked) return;
        _fund(USDC, 1000e6);
        _fund(USDT, 1000e6);
        bytes memory p1 = _path(USDC, FEE, USDT, FEE, WARS);
        bytes memory p2 = _path(USDT, FEE, WARS);
        uint256 out = (_q(p1, 20e6) + _q(p2, 30e6)) * 99 / 100;
        _run(
            "GAS 2legs usdc(3009,2hops)+usdt(permit2,1hop)",
            _inv(out, WARS, "e"),
            _legs2(_leg(USDC, 20e6, ICobraRouter.PullKind.EIP3009, p1), _leg(USDT, 30e6, ICobraRouter.PullKind.PERMIT2, p2))
        );
    }

    function test_gas_2legs_usdt3009_usdcPermit2_1hop_each_target_wBRL() public {
        if (!forked) return;
        _fund(USDT, 1000e6);
        _fund(USAT, 1000e6);
        bytes memory p1 = _path(USDT, FEE, WBRL);
        bytes memory p2 = _path(USAT, FEE, USDT, FEE, WBRL);
        uint256 out = (_q(p1, 20e6) + _q(p2, 30e6)) * 99 / 100;
        _run(
            "GAS 2legs usdt(3009,1hop)+usat(permit2,2hops)->wBRL",
            _inv(out, WBRL, "f"),
            _legs2(_leg(USDT, 20e6, ICobraRouter.PullKind.EIP3009, p1), _leg(USAT, 30e6, ICobraRouter.PullKind.PERMIT2, p2))
        );
    }

    function test_gas_1leg_wARS_permit2_direct() public {
        if (!forked) return;
        _fund(WARS, 10000e18);
        _run("GAS wARS->wARS 1leg PERMIT2 no swap", _inv(4500e18, WARS, "g"), _legs1(_leg(WARS, 4500e18, ICobraRouter.PullKind.PERMIT2, "")));
    }

    function test_gas_1leg_wBRL_to_wARS_viaUSDT_expectedRevert() public {
        if (!forked) return;
        _fund(WBRL, 1000e18);
        bytes memory p = _path(WBRL, FEE, USDT, FEE, WARS);
        ICobraRouter.Invoice memory inv = _inv(1000e18, WARS, "h");
        ICobraRouter.Leg[] memory legs = _legs1(_leg(WBRL, 10e18, ICobraRouter.PullKind.PERMIT2, p));
        _sign(router, PAYER_PK, inv, legs);
        vm.prank(relayer);
        try router.pay(inv, payer, legs) {
            emit log("GAS wBRL->USDT->wARS: succeeded (unexpected)");
        } catch (bytes memory r) {
            emit log_named_bytes("GAS wBRL->USDT->wARS reverted", r);
        }
    }
}
