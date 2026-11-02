// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICobraRouter} from "../../src/ICobraRouter.sol";
import {CobraRouter} from "../../src/CobraRouter.sol";
import {SigUtils} from "../utils/SigUtils.sol";

interface IERC20Fork {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IQuoterV2 {
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256 gasEstimate);
}

interface IFactoryGetter {
    function factory() external view returns (address);
}

/// @notice Celo mainnet fork tests against the REAL Permit2, SwapRouter02, QuoterV2 and tokens.
///         Addresses: docs/research/onchain-verification.md (verified at block ~81.73M). Every address is re-checked
///         here (code.length > 0, symbol / factory / domain separator) before use. Skipped if the RPC is unreachable.
contract CobraRouterForkTest is SigUtils {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant SWAP_ROUTER02 = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;
    address internal constant QUOTER_V2 = 0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8;
    address internal constant FACTORY = 0xAfE208a311B21f13EF87E33A90049fC17A7acDEc;
    address internal constant USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C;
    address internal constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address internal constant WARS = 0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D;
    address internal constant WBRL = 0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0;
    bytes32 internal constant PERMIT2_DOMAIN = 0xec832d34f61a0ea7e5bcde106cdda913dd6fcf3f2c65b6bf7e25f70afed47d0a;
    uint24 internal constant FEE = 100;

    bool internal forked;
    CobraRouter internal router;
    address internal payer;
    address internal merchant = makeAddr("fork-merchant");
    address internal relayer = makeAddr("fork-relayer");

    function setUp() public {
        string memory rpc = vm.envOr("CELO_RPC_URL", string("https://forno.celo.org"));
        try vm.createSelectFork(rpc) {
            forked = block.chainid == 42220;
        } catch {
            forked = false;
        }
        if (!forked) return;

        // Never trust a remembered address.
        assertGt(PERMIT2.code.length, 0, "permit2 code");
        assertEq(IERC20Fork(PERMIT2).DOMAIN_SEPARATOR(), PERMIT2_DOMAIN, "permit2 domain");
        assertGt(SWAP_ROUTER02.code.length, 0, "swaprouter code");
        assertEq(IFactoryGetter(SWAP_ROUTER02).factory(), FACTORY, "swaprouter factory");
        assertGt(QUOTER_V2.code.length, 0, "quoter code");
        assertEq(IFactoryGetter(QUOTER_V2).factory(), FACTORY, "quoter factory");
        _checkToken(USDC, "USDC", 6);
        _checkToken(USDT, unicode"USD₮", 6);
        _checkToken(WARS, "wARS", 18);
        _checkToken(WBRL, "wBRL", 18);

        router = new CobraRouter(PERMIT2, SWAP_ROUTER02);
        payer = vm.addr(PAYER_PK);
        // The public anvil #0 address carries an EIP-7702 delegation on Celo mainnet (code 0xef0100…), which makes
        // USDC/USDT/Permit2 verify via ERC-1271 instead of ecrecover. Clear it in the LOCAL fork only.
        if (payer.code.length != 0) vm.etch(payer, "");
        assertEq(payer.code.length, 0, "payer must be a plain EOA in the fork");
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _checkToken(address t, string memory sym, uint8 dec) internal view {
        assertGt(t.code.length, 0, sym);
        assertEq(IERC20Fork(t).symbol(), sym, "symbol");
        assertEq(IERC20Fork(t).decimals(), dec, "decimals");
    }

    function _domain(string memory name, string memory version, address token) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                uint256(42220),
                token
            )
        );
    }

    function _fund(address token, uint256 amount) internal {
        deal(token, payer, amount); // works through the proxies (stdstore probes the implementation's slot)
        assertEq(IERC20Fork(token).balanceOf(payer), amount, "deal");
        vm.prank(payer);
        IERC20Fork(token).approve(PERMIT2, type(uint256).max);
    }

    function _quote(bytes memory path, uint256 amountIn) internal returns (uint256 out) {
        (out,,,) = IQuoterV2(QUOTER_V2).quoteExactInput(path, amountIn);
    }

    function _invoice(uint256 amountOut, address tokenOut) internal view returns (ICobraRouter.Invoice memory) {
        return ICobraRouter.Invoice({
            id: keccak256(abi.encode("fork", amountOut, tokenOut)),
            merchant: merchant,
            tokenOut: tokenOut,
            amountOut: amountOut,
            deadline: block.timestamp + 30 minutes
        });
    }

    function _assertRouterEmpty() internal view {
        address[4] memory ts = [USDC, USDT, WARS, WBRL];
        for (uint256 i; i < 4; ++i) {
            assertEq(IERC20Fork(ts[i]).balanceOf(address(router)), 0, "router balance");
            assertEq(IERC20Fork(ts[i]).allowance(address(router), SWAP_ROUTER02), 0, "router allowance");
        }
    }

    // ───────────────────────────── signing domains used by packages/shared/src/tokens.ts ─────────────────────────────

    function test_fork_tokenDomains() public onlyFork {
        assertEq(IERC20Fork(USDC).DOMAIN_SEPARATOR(), _domain("USDC", "2", USDC), "USDC domain");
        assertEq(IERC20Fork(USDT).DOMAIN_SEPARATOR(), _domain("Tether USD", "1", USDT), "USDT domain");
        assertEq(IERC20Fork(WARS).DOMAIN_SEPARATOR(), _domain("Peso Argentino", "1", WARS), "wARS domain");
    }

    // ───────────────────────────── payments ─────────────────────────────

    function test_fork_permit2_wARS_direct() public onlyFork {
        _fund(WARS, 10_000e18);
        ICobraRouter.Invoice memory inv = _invoice(4500e18, WARS);
        ICobraRouter.Leg[] memory legs = _legs1(_leg(WARS, 4500e18, ICobraRouter.PullKind.PERMIT2, ""));
        _sign(router, PAYER_PK, inv, legs);
        vm.prank(relayer);
        router.pay(inv, payer, legs);
        assertEq(IERC20Fork(WARS).balanceOf(merchant), 4500e18);
        assertEq(IERC20Fork(WARS).balanceOf(payer), 5500e18);
        assertTrue(router.isPaid(router.hashInvoice(inv)));
        _assertRouterEmpty();
    }

    function test_fork_eip3009_usdt_to_wARS() public onlyFork {
        _fund(USDT, 1_000e6);
        bytes memory path = _path(USDT, FEE, WARS);
        uint256 amountIn = 50e6;
        uint256 quoted = _quote(path, amountIn);
        uint256 amountOut = quoted * 99 / 100; // 1% buffer, the rest is refunded
        ICobraRouter.Invoice memory inv = _invoice(amountOut, WARS);
        ICobraRouter.Leg[] memory legs = _legs1(_leg(USDT, amountIn, ICobraRouter.PullKind.EIP3009, path));
        _sign(router, PAYER_PK, inv, legs);

        vm.prank(relayer);
        router.pay(inv, payer, legs);

        assertEq(IERC20Fork(WARS).balanceOf(merchant), amountOut, "merchant exact");
        assertEq(IERC20Fork(WARS).balanceOf(payer), quoted - amountOut, "surplus refunded");
        assertEq(IERC20Fork(USDT).balanceOf(payer), 950e6);
        _assertRouterEmpty();
    }

    function test_fork_eip3009_usdc_twoHops_to_wARS() public onlyFork {
        _fund(USDC, 1_000e6);
        bytes memory path = _path(USDC, FEE, USDT, FEE, WARS); // no wFIAT/USDC pool on Celo
        uint256 amountIn = 50e6;
        uint256 quoted = _quote(path, amountIn);
        ICobraRouter.Invoice memory inv = _invoice(quoted, WARS); // zero buffer: exact quote
        ICobraRouter.Leg[] memory legs = _legs1(_leg(USDC, amountIn, ICobraRouter.PullKind.EIP3009, path));
        _sign(router, PAYER_PK, inv, legs);
        vm.prank(relayer);
        router.pay(inv, payer, legs);
        assertEq(IERC20Fork(WARS).balanceOf(merchant), quoted);
        assertEq(IERC20Fork(WARS).balanceOf(payer), 0);
        _assertRouterEmpty();
    }

    function test_fork_twoLegs_usdc3009_usdtPermit2() public onlyFork {
        _fund(USDC, 1_000e6);
        _fund(USDT, 1_000e6);
        bytes memory p1 = _path(USDC, FEE, USDT, FEE, WARS);
        bytes memory p2 = _path(USDT, FEE, WARS);
        uint256 q1 = _quote(p1, 20e6);
        // second quote after the first swap's price impact is not modelled; keep a 0.5% buffer
        uint256 q2 = _quote(p2, 30e6);
        uint256 amountOut = (q1 + q2) * 995 / 1000;
        ICobraRouter.Invoice memory inv = _invoice(amountOut, WARS);
        ICobraRouter.Leg[] memory legs = _legs2(
            _leg(USDC, 20e6, ICobraRouter.PullKind.EIP3009, p1), _leg(USDT, 30e6, ICobraRouter.PullKind.PERMIT2, p2)
        );
        _sign(router, PAYER_PK, inv, legs);
        vm.prank(relayer);
        router.pay(inv, payer, legs);
        assertEq(IERC20Fork(WARS).balanceOf(merchant), amountOut);
        assertGt(IERC20Fork(WARS).balanceOf(payer), 0, "surplus");
        assertEq(IERC20Fork(USDC).balanceOf(payer), 980e6);
        assertEq(IERC20Fork(USDT).balanceOf(payer), 970e6);
        _assertRouterEmpty();
    }

    function test_fork_threeLegs_mixed_payerSends() public onlyFork {
        _fund(USDC, 100e6);
        _fund(USDT, 100e6);
        _fund(WARS, 10_000e18);
        bytes memory p1 = _path(USDC, FEE, USDT, FEE, WARS);
        bytes memory p2 = _path(USDT, FEE, WARS);
        uint256 amountOut = (_quote(p1, 5e6) + _quote(p2, 5e6)) * 99 / 100 + 1000e18;
        ICobraRouter.Invoice memory inv = _invoice(amountOut, WARS);
        ICobraRouter.Leg[] memory legs = _legs3(
            _leg(USDC, 5e6, ICobraRouter.PullKind.EIP3009, p1),
            _leg(USDT, 5e6, ICobraRouter.PullKind.PERMIT2, p2),
            _leg(WARS, 1000e18, ICobraRouter.PullKind.ALLOWANCE, "")
        );
        _sign(router, PAYER_PK, inv, legs);
        vm.startPrank(payer);
        IERC20Fork(WARS).approve(address(router), 1000e18);
        router.pay(inv, payer, legs);
        vm.stopPrank();
        assertEq(IERC20Fork(WARS).balanceOf(merchant), amountOut);
        _assertRouterEmpty();
    }

    function test_fork_usdt_to_wBRL_buySide() public onlyFork {
        _fund(USDT, 1_000e6);
        bytes memory path = _path(USDT, FEE, WBRL);
        uint256 quoted = _quote(path, 10e6);
        ICobraRouter.Invoice memory inv = _invoice(quoted, WBRL);
        ICobraRouter.Leg[] memory legs = _legs1(_leg(USDT, 10e6, ICobraRouter.PullKind.PERMIT2, path));
        _sign(router, PAYER_PK, inv, legs);
        vm.prank(relayer);
        router.pay(inv, payer, legs);
        assertEq(IERC20Fork(WBRL).balanceOf(merchant), quoted);
        _assertRouterEmpty();
    }

    function test_fork_insufficientOutput_reverts_nothingConsumed() public onlyFork {
        _fund(USDT, 1_000e6);
        bytes memory path = _path(USDT, FEE, WARS);
        uint256 quoted = _quote(path, 50e6);
        ICobraRouter.Invoice memory inv = _invoice(quoted + 1, WARS);
        ICobraRouter.Leg[] memory legs = _legs1(_leg(USDT, 50e6, ICobraRouter.PullKind.EIP3009, path));
        _sign(router, PAYER_PK, inv, legs);
        vm.expectRevert(abi.encodeWithSelector(ICobraRouter.InsufficientOutput.selector, quoted, quoted + 1));
        vm.prank(relayer);
        router.pay(inv, payer, legs);
        assertEq(IERC20Fork(USDT).balanceOf(payer), 1_000e6);
        assertFalse(router.isPaid(router.hashInvoice(inv)));
    }

    function test_fork_tamperedMerchant_realTokensReject() public onlyFork {
        _fund(USDT, 1_000e6);
        _fund(WARS, 10_000e18);
        bytes memory path = _path(USDT, FEE, WARS);
        ICobraRouter.Invoice memory inv = _invoice(1e18, WARS);
        ICobraRouter.Leg[] memory legs = _legs2(
            _leg(USDT, 1e6, ICobraRouter.PullKind.EIP3009, path), _leg(WARS, 1e18, ICobraRouter.PullKind.PERMIT2, "")
        );
        _sign(router, PAYER_PK, inv, legs);
        inv.merchant = relayer;
        // nonce is derived from a different digest -> the real USDT rejects the authorization
        vm.expectRevert(bytes("TetherToken: invalid signature"));
        vm.prank(relayer);
        router.pay(inv, payer, legs);

        // Permit2 leg alone with tampered merchant: real Permit2 rejects the witness
        inv.merchant = merchant;
        ICobraRouter.Leg[] memory l2 = _legs1(_leg(WARS, 1e18, ICobraRouter.PullKind.PERMIT2, ""));
        _sign(router, PAYER_PK, inv, l2);
        inv.merchant = relayer;
        vm.expectRevert(abi.encodeWithSignature("InvalidSigner()")); // real Permit2 rejects the witness
        vm.prank(relayer);
        router.pay(inv, payer, l2);
    }
}
