# Cobrá: on-chain verification on Celo mainnet (chainId 42220)

Researched 2026-11-02 at Celo block ~81,728,773 over `https://forno.celo.org` (Foundry `cast`). Everything here was read-only. No transactions were sent and no keys were used.

Confidence labels:
- **[on-chain]**: bytecode exists (`cast code`) and a call confirms what the contract is (symbol, factory, domain separator, and so on).
- **[docs]**: taken from official docs only.
- **[unknown]**: could not be confirmed.

## Machine-readable summary

```json
{
  "chainId": 42220,
  "verifiedAtBlock": 81728773,
  "permit2": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  "permit2DomainSeparator": "0xec832d34f61a0ea7e5bcde106cdda913dd6fcf3f2c65b6bf7e25f70afed47d0a",
  "uniswap": {
    "factory": "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc",
    "swapRouter": "0x5615CDAb10dc425a742d643d949a7F474C01abc4",
    "swapRouterKind": "SwapRouter02",
    "quoterV2": "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8",
    "universalRouter": "0x643770E279d5D0733F21d6DC03A8efbABf3255B4",
    "nonfungiblePositionManager": "0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A",
    "WETH9": "0x0000000000000000000000000000000000000000"
  },
  "tokens": [
    {"symbol": "USDC", "address": "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", "decimals": 6, "eip3009": true, "eip2612": true, "eip712Name": "USDC", "eip712Version": "2", "domainSeparator": "0xb2ce31d2838445fa765a491f550e7c78ac7280ab0f3bc9d6063a86df9c3fb578", "proxy": "FiatTokenProxy (zos slot)", "implementation": "0xda06d4e3f59fe2c8ff3077a9d50d5be5e231becd", "blocklist": true, "feeOnTransfer": false, "feeCurrencyAdapter": "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B", "verified": true},
    {"symbol": "USD₮", "address": "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", "decimals": 6, "eip3009": true, "eip2612": true, "eip712Name": "Tether USD", "eip712Version": "1", "domainSeparator": "0xbcb4d62e4834b598d0eacecd84c0b397a0254e077c41cf2143e394d5701d1088", "proxy": "EIP-1967 transparent", "implementation": "0xbf83f8436ac46a8b1da5a9348ed84f68aee07b98", "blocklist": true, "feeOnTransfer": false, "feeCurrencyAdapter": "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72", "verified": true},
    {"symbol": "USAT", "address": "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", "decimals": 6, "eip3009": true, "eip2612": true, "eip712Name": "Tether America USD", "eip712Version": "1", "domainSeparator": "0xe6bbb7920a85afd44befe87c998da24b8b655c972faf8a8acbdf38c829ff8bf2", "proxy": "EIP-1967 transparent", "implementation": "0xdcc9e86b559d04dae816caba1e44481fe7903e59", "blocklist": true, "feeOnTransfer": false, "feeCurrencyAdapter": "0x0357EE22278c922e1D36cFe6b899269b161880C4", "verified": true},
    {"symbol": "USDm", "address": "0x765DE816845861e75A25fCA122bb6898B8B1282a", "decimals": 18, "eip3009": false, "eip2612": true, "eip712Name": null, "eip712Version": null, "domainSeparator": "0x87dc81e9af25fccc08210ea13f812e6f04c060051856b7e2ccc405063f6d2f97", "proxy": "EIP-1967 slots (Celo proxy)", "implementation": "0x815795c30d0758a297b08cd4e0643620c974c318", "blocklist": false, "feeOnTransfer": false, "feeCurrencyAdapter": null, "isFeeCurrency": true, "verified": true},
    {"symbol": "wARS", "address": "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d", "decimals": 18, "eip3009": false, "eip2612": true, "eip712Name": "Peso Argentino", "eip712Version": "1", "domainSeparator": "0x8fd0e082d786c29cb2a88f8ea8b75e6b8c270bdbbab4443eac0c594e3df7e408", "proxy": "UUPS (ERC-1967)", "implementation": "0xba0030bba7112171a8a5bcc417ee1994051321b9", "blocklist": "optional, currently not enforced", "feeOnTransfer": false, "verified": true},
    {"symbol": "wBRL", "address": "0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0", "decimals": 18, "eip3009": false, "eip2612": true, "eip712Name": "Real Brasileño", "eip712Version": "1", "domainSeparator": "0xed29cfeeb3cbd18dfe3aac7d57fccdf64a4d9249205a52b710c96d1f5a5da8d3", "proxy": "UUPS (ERC-1967)", "implementation": "0xfbab5dcb1647787ec8402a6509add256fa6c7f9d", "blocklist": "optional, currently not enforced", "feeOnTransfer": false, "verified": true},
    {"symbol": "wMXN", "address": "0x337e7456b420bd3481e7fa61fa9850343d610d34", "decimals": 18, "eip3009": false, "eip2612": true, "eip712Name": "Peso Mexicano", "eip712Version": "1", "proxy": "UUPS (ERC-1967)", "implementation": "0x425abec6165c83d30fcf81ec66635c6c7ee2bbf7", "feeOnTransfer": false, "verified": true},
    {"symbol": "wCOP", "address": "0x8a1d45e102e886510e891d2ec656a708991e2d76", "decimals": 18, "eip3009": false, "eip2612": true, "eip712Name": "Peso Colombiano", "eip712Version": "1", "proxy": "UUPS (ERC-1967)", "implementation": "0x6f6206fac28d9f60d221a63aae5fb5c3a9ea6652", "feeOnTransfer": false, "verified": true},
    {"symbol": "wCLP", "address": "0x61D450a098b6a7f69fC4b98CE68198fe59768651", "decimals": 18, "eip3009": false, "eip2612": true, "eip712Name": "Peso Chileno", "eip712Version": "1", "proxy": "UUPS (ERC-1967)", "implementation": "0x8898786f1e1e9ed77def940a2ecb7cf07af8d6ba", "feeOnTransfer": false, "verified": true},
    {"symbol": "wPEN", "address": "0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE", "decimals": 18, "eip3009": false, "eip2612": true, "eip712Name": "Sol Peruano", "eip712Version": "1", "proxy": "UUPS (ERC-1967)", "implementation": "0x9d6266a9167f17ff3dd20f63a474812d0cd47969", "feeOnTransfer": false, "verified": true}
  ],
  "pools": [
    {"tokenA": "wARS", "tokenB": "USDT", "fee": 100, "address": "0x5D8ef8B839be522b9E3d60a51EDB5837CD0b2391", "liquidity": "75296905296238564236", "tick": -350418, "token0": "wARS", "priceUSDTtoWARS": 1650.23, "tvlUsdApprox": 106600},
    {"tokenA": "wBRL", "tokenB": "USDT", "fee": 100, "address": "0x01c3cf91cdf7B34181C7eC8566c0236951FEA40F", "liquidity": "912959230885651704", "tick": 293038, "token0": "USDT", "priceUSDTtoWBRL": 5.3191, "tvlUsdApprox": 27700, "note": "one-sided: 147,084 wBRL vs 23.25 USDT"},
    {"tokenA": "USDC", "tokenB": "USDT", "fee": 100, "address": "0x1a810e0B6c2dd5629AFa2f0c898b9512C6F78846", "liquidity": "41009885194619", "tick": -12, "token0": "USDT"},
    {"tokenA": "USDC", "tokenB": "USDT", "fee": 500, "address": "0x2392AE4Ba6Daf181CE7343d237b695CdF525E233", "liquidity": "0"},
    {"tokenA": "USDC", "tokenB": "USDT", "fee": 3000, "address": "0x9AfAc41cbd701a184a74475Aa8BDcda6a1a564a1", "liquidity": "3500693"},
    {"tokenA": "USAT", "tokenB": "USDT", "fee": 100, "address": "0x070D575a713EaF5025462D0865Fb0Dac4B14bC38", "liquidity": "24646299225153"},
    {"tokenA": "USAT", "tokenB": "USDT", "fee": 500, "address": "0xaE073a816117DcD1cC237fe4CB99F89F8F8bfF4F", "liquidity": "0"},
    {"tokenA": "USDm", "tokenB": "USDT", "fee": 100, "address": "0x5dC631aD6C26BEA1a59fBF2C2680CF3df43d249f", "liquidity": "418615457532966489308"},
    {"tokenA": "USDm", "tokenB": "USDC", "fee": 100, "address": "0x34757893070B0FC5de37AaF2844255fF90F7F1E0", "liquidity": "1293344179676786442"}
  ],
  "feeCurrencyDirectory": "0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276",
  "erc8004": {
    "identityRegistry": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    "reputationRegistry": "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    "validationRegistry": "0x8004cc8439f36fd5f9f049d9ff86523df6daab58",
    "register": "register(string agentURI) returns (uint256 agentId)"
  },
  "attributionTags": {
    "version": "0.5.0",
    "api": "withAttribution(code: string | string[]) => viem client.extend(); toDataSuffix(code); toRoleDataSuffix({app,wallet,service}); fromDataSuffix(hex); verifyTx({client,hash}); codeFromHostname(h); codeFromRepo(r)"
  }
}
```

---

## 1. Permit2 [on-chain]

- **Address:** `0x000000000022D473030F116dDEE9F6B43aC78BA3`. It is deployed: `cast code` returns about 9.1 KB of bytecode.
- **DOMAIN_SEPARATOR:** `0xec832d34f61a0ea7e5bcde106cdda913dd6fcf3f2c65b6bf7e25f70afed47d0a`
  - Read with `cast call 0x000000000022D473030F116dDEE9F6B43aC78BA3 "DOMAIN_SEPARATOR()(bytes32)" --rpc-url https://forno.celo.org`.
  - I recomputed it independently as `keccak256(abi.encode(keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"), keccak256("Permit2"), 42220, permit2))`. The result is identical, so this is canonical Permit2 (it has no version field).
- **Docs:** the Uniswap Celo deployments page lists the same address: https://developers.uniswap.org/docs/protocols/v3/deployments/v3-celo-deployments

## 2. Uniswap V3 on Celo [on-chain + docs]

| Contract | Address | Check |
|---|---|---|
| UniswapV3Factory | `0xAfE208a311B21f13EF87E33A90049fC17A7acDEc` | `owner()` = `0xB9952C01830306ea2fAAe1505f6539BD260Bfc48`; `feeAmountTickSpacing(100)` = 1, so the 0.01% tier is enabled |
| SwapRouter02 | `0x5615CDAb10dc425a742d643d949a7F474C01abc4` | `factory()` = Factory above; `positionManager()` = `0x3d79EdAa...D95A`; `WETH9()` = `0x0`; `factoryV2()` = `0x0` |
| QuoterV2 | `0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8` | `factory()` = Factory above; `WETH9()` = `0x0` |
| UniversalRouter | `0x643770E279d5D0733F21d6DC03A8efbABf3255B4` | docs only |
| NonfungiblePositionManager | `0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A` | returned by `SwapRouter02.positionManager()` |

**The router is SwapRouter02.** Its `exactInput` struct has **no deadline** field. I checked this by grepping the runtime bytecode for `PUSH4 <selector>` in the dispatcher:

- **Present:**
  - `0xb858183f` exactInput((bytes,address,uint256,uint256))
  - `0x04e45aaf` exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
  - `0x09b81346` exactOutput((bytes,address,uint256,uint256))
  - `0x5023b4df` exactOutputSingle(...)
  - `0x5ae401dc` multicall(uint256 deadline, bytes[])
  - `0x1f0464d1` multicall(bytes32, bytes[])
- **Absent** (these are the original SwapRouter's deadline variants):
  - `0xc04b8d59` exactInput((bytes,address,uint256,uint256,uint256))
  - `0x414bf389` exactInputSingle(... deadline ...)

To enforce a deadline, wrap the call in `multicall(uint256 deadline, bytes[])` or check `block.timestamp` in the Cobrá router.

`WETH9 = 0x0` on Celo because CELO is natively an ERC-20 at `0x471EcE3750Da237f93B8E339c536989b8978a438`. Do not rely on ETH unwrap/refund paths.

The docs page (link in section 1) lists the same Factory, SwapRouter02, QuoterV2, UniversalRouter and Permit2 addresses.

## 3. Tokens [on-chain]

Each token was checked with:

```
cast call <t> "symbol()(string)"; "name()(string)"; "decimals()(uint8)"; "totalSupply()(uint256)"
```

The addresses come from the Celo docs stablecoin list (https://docs.celo.org/build/tools/contracts/stablecoin-contracts) and the Ripio announcement (https://action.ripio.com/en/blog/wfiat-stablecoins-now-live-on-celo). The Ripio Bridge developer docs (https://bridge.ripio.com/developers) say wFIAT tokens use the same address on every EVM chain.

| Symbol (on-chain) | Name (on-chain) | Address | Dec | totalSupply (Celo) | Issuer |
|---|---|---|---|---|---|
| USDC | USDC | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | 6 | 15.70M | Circle |
| USD₮ | Tether USD | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | 6 | 470.0M | Tether |
| USAT | Tether America USD | `0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771` | 6 | 327,790 | Anchorage Digital Bank, per Celo docs (Tether's US token) |
| USDm (formerly cUSD) | Mento Dollar | `0x765DE816845861e75A25fCA122bb6898B8B1282a` | 18 | 13.45M | Mento |
| wARS | Peso Argentino | `0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d` | 18 | 326.06M wARS | Ripio |
| wBRL | Real Brasileño | `0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0` | 18 | 3.88M wBRL | Ripio |
| wMXN | Peso Mexicano | `0x337e7456b420bd3481e7fa61fa9850343d610d34` | 18 | 13,190 wMXN | Ripio |
| wCOP | Peso Colombiano | `0x8a1d45e102e886510e891d2ec656a708991e2d76` | 18 | 34.48M wCOP | Ripio |
| wCLP | Peso Chileno | `0x61D450a098b6a7f69fC4b98CE68198fe59768651` | 18 | 1.005M wCLP | Ripio |
| wPEN | Sol Peruano | `0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE` | 18 | 603 wPEN | Ripio |

Notes:
- The two claimed addresses for wARS and wBRL are **confirmed**.
- All six wFIATs were deployed by `0xdf202429911c19a517cbf2ff6afc37d3836208dc` (Etherscan `getcontractcreation`, chain 42220). wARS was created in tx `0xb0e48596...` at block 68,435,445.
- USDT's symbol is the Unicode string `"USD₮"` (U+20AE), not `"USDT"`. USAT's on-chain symbol is the ASCII string `"USAT"`; the Celo docs display it as "USA₮".

## 4. Signature support per token [on-chain]

Method:
1. Read the implementation address from the EIP-1967 slot `0x3608...2bbc`. USDC uses the ZeppelinOS slot `0x7050c9e0...f8c3`.
2. Grep the implementation bytecode for `63<selector>` (PUSH4).
3. Confirm with static calls: `authorizationState(address,bytes32)` returns `false` where EIP-3009 exists and reverts where it does not; `nonces(address)` returns 0 for all tokens.
4. Verify every `DOMAIN_SEPARATOR()` by recomputing it from the (name, version) shown below.

| Token | receiveWithAuthorization `0xef55bec6` | transferWithAuthorization `0xe3ee160e` | bytes-sig variants (`0x88b7ab63` / `0xcf092995`, ERC-1271) | permit `0xd505accf` | eip712Domain (5267) | EIP-712 name / version | Proxy type → impl | Blocklist / pause |
|---|---|---|---|---|---|---|---|---|
| USDC | yes | yes | yes | yes | no (reverts) | "USDC" / "2" (`version()` returns "2") | FiatTokenProxy → `0xda06d4e3f59fe2c8ff3077a9d50d5be5e231becd`, admin `0x2973d27f9873babb7f2c48716234b901d4e7b494` | `isBlacklisted`, `blacklist`, `pause` |
| USD₮ | yes | yes | yes | yes | no (reverts); no `version()` | "Tether USD" / "1" (found by recomputing the domain separator) | EIP-1967 → `0xbf83f8436ac46a8b1da5a9348ed84f68aee07b98`, admin `0xdfb794502984097328bb90cf3e5653085c102c25` | `isBlocked`, `addToBlockedList` |
| USAT | yes | yes | yes | yes | yes | "Tether America USD" / "1" | EIP-1967 → `0xdcc9e86b559d04dae816caba1e44481fe7903e59`, admin `0x407cea8bc0b1c42a72a1f38e3c8e60a3929f7422` | `isBlocked` |
| USDm | no | no | no | yes | no | unknown: the domain separator `0x87dc81e9…` matched none of "Mento Dollar", "Celo Dollar", "USDm", "cUSD" or "StableToken" with versions 1, 2, 1.0 or 1.0.0 | EIP-1967 slots → `0x815795c30d0758a297b08cd4e0643620c974c318` | none detected |
| wARS / wBRL / wMXN / wCOP / wCLP / wPEN | **no** | **no** | no | **yes** | yes | `name()` / "1" (for example "Peso Argentino" / "1") | UUPS (ERC-1967, no admin slot); `upgradeToAndCall` gated by `UPGRADER_ROLE` | `isBlocked` + `pause()`; `enforceBlocklist()` = **false** today; `paused()` = false |

Domain separators:

| Token | DOMAIN_SEPARATOR |
|---|---|
| USDC | `0xb2ce31d2838445fa765a491f550e7c78ac7280ab0f3bc9d6063a86df9c3fb578` |
| USD₮ | `0xbcb4d62e4834b598d0eacecd84c0b397a0254e077c41cf2143e394d5701d1088` |
| USAT | `0xe6bbb7920a85afd44befe87c998da24b8b655c972faf8a8acbdf38c829ff8bf2` |
| USDm | `0x87dc81e9af25fccc08210ea13f812e6f04c060051856b7e2ccc405063f6d2f97` |
| wARS | `0x8fd0e082d786c29cb2a88f8ea8b75e6b8c270bdbbab4443eac0c594e3df7e408` |
| wBRL | `0xed29cfeeb3cbd18dfe3aac7d57fccdf64a4d9249205a52b710c96d1f5a5da8d3` |

**wFIAT source** (verified on CeloScan / Etherscan v2, impl `0xba0030bb…`): contract `LatamStable`, solc 0.8.27, built on OpenZeppelin v5 upgradeable. It is ERC20 + Burnable + Pausable + AccessControl + ERC20Permit + UUPS.
- Its `_update` only adds an optional blocklist check, so there is **no fee-on-transfer**.
- The roles are PAUSER, MINTER, UPGRADER and COMPLIANCE. `setEnforceBlocklist`, `blockUser` and `unblockUser` are callable by COMPLIANCE_ROLE.
- The other four wFIAT implementations have the same bytecode length (19,715 hex chars) and the same selector set. They differ only in immutables such as the self-address, so they are almost certainly the same source. Only wARS was source-checked.

**Fee-on-transfer:** no fee getters exist (`fee()` and `transferFee()` are absent everywhere). USDC, USDT and USAT are Circle/Tether standard contracts, and the Quoter's exact-output results are consistent with plain transfers. I found no fee-on-transfer on any token. This is [on-chain] for wFIAT (source read) and bytecode-only for the others.

USDC/USDT/USAT also expose `debitGasFees` / `creditGasFees`, the Celo fee-currency hooks.

## 5. Uniswap V3 pools and depth [on-chain]

Pools were found with `getPool(a, b, fee)` on the Factory for fees 100, 500, 3000 and 10000. Pool state came from `liquidity()`, `slot0()`, `token0()` and `balanceOf(pool)`.

Pairs with **no pool at any fee tier**:
- wARS against USDC, USDm, CELO or wBRL.
- wBRL against USDC, USDm or CELO.
- **wMXN, wCOP, wCLP and wPEN against USDT, USDC, USAT or USDm.** These tokens are not routable on Uniswap V3 today.

| Pair | Fee | Pool | liquidity() | tick | Reserves |
|---|---|---|---|---|---|
| wARS/USDT | 0.01% | `0x5D8ef8B839be522b9E3d60a51EDB5837CD0b2391` | 75,296,905,296,238,564,236 | -350418 | 123.94M wARS (~$75k) + 31,502 USDT → **~$106k TVL** |
| wBRL/USDT | 0.01% | `0x01c3cf91cdf7B34181C7eC8566c0236951FEA40F` | 912,959,230,885,651,704 | 293038 (token0 = USDT) | 147,084 wBRL (~$27.7k) + **23.25 USDT** → one-sided |
| USDC/USDT | 0.01% | `0x1a810e0B6c2dd5629AFa2f0c898b9512C6F78846` | 41,009,885,194,619 | -12 | 23,303 USDC + 164,800 USDT |
| USDC/USDT | 0.05% | `0x2392AE4Ba6Daf181CE7343d237b695CdF525E233` | 0 | -1 | dust |
| USDC/USDT | 0.3% | `0x9AfAc41cbd701a184a74475Aa8BDcda6a1a564a1` | 3,500,693 | 6 | ~3.5 + 3.5 |
| USAT/USDT | 0.01% | `0x070D575a713EaF5025462D0865Fb0Dac4B14bC38` | 24,646,299,225,153 | n/a | not read |
| USDm/USDT | 0.01% | `0x5dC631aD6C26BEA1a59fBF2C2680CF3df43d249f` | 4.19e20 | 276311 | 621,204 USDT + 23,136 USDm |
| USDm/USDC | 0.01% | `0x34757893070B0FC5de37AaF2844255fF90F7F1E0` | 1.29e18 | n/a | 206 USDC + 115 USDm |

### Quotes (QuoterV2, `cast call`, sqrtPriceLimit = 0)

The commands used:

```
cast call 0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8 \
  "quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)" \
  "(USDT,wARS,50000000,100,0)" --rpc-url https://forno.celo.org

cast call ... "quoteExactOutputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)" "(USDT,wARS,<amountOut>,100,0)"

cast call ... "quoteExactOutput(bytes,uint256)(uint256,uint160[],uint32[],uint256)" <path> <amountOut>
```

The path for `quoteExactOutput` is `wARS|000064|USDT|000064|USDC`, that is, reversed for exact output.

**USDT → wARS (exact input, 0.01%)**

| In (USDT) | Out (wARS) | Effective rate | Impact vs 1-USDT quote |
|---|---|---|---|
| 1 | 1,650.23 | 1650.23 | n/a |
| 50 | 82,509.16 | 1650.18 | -0.003% |
| 500 | 824,891.34 | 1649.78 | -0.03% |
| 5,000 | 8,228,941.86 | 1645.79 | -0.27% |
| 20,000 | 32,652,251.08 | 1632.61 | -1.07% |

**USDT → wBRL (exact input, 0.01%)**

| In (USDT) | Out (wBRL) | Effective rate | Impact |
|---|---|---|---|
| 1 | 5.3191 | 5.3191 | n/a |
| 50 | 265.92 | 5.3185 | -0.01% |
| 500 | 2,656.22 | 5.3124 | -0.13% |
| 5,000 | 26,264.03 | 5.2528 | -1.25% |
| 20,000 | 101,266.84 | 5.0633 | -4.8% |

**Exact output** (the Cobrá use case, where the merchant receives an exact amount):

| Merchant receives | Payer pays |
|---|---|
| 82,500 wARS | 49.98 USDT |
| 825,000 wARS | 499.94 USDT |
| 8,250,000 wARS | 5,011.56 USDT |
| 266 wBRL | 50.01 USDT |
| 2,660 wBRL | 500.71 USDT |
| 26,600 wBRL | 5,064.78 USDT |

**Multi-hop USDC → USDT → wARS/wBRL** (exactOutput):

| Merchant receives | Payer pays |
|---|---|
| 825,000 wARS | 499.39 USDC |
| 2,660 wBRL | 500.16 USDC |

USDC trades about 0.11% above USDT. USDC → USDT exact input:

| In (USDC) | Out (USDT) |
|---|---|
| 1 | 1.001111 |
| 500 | 500.5496 |
| 5,000 | 5,005.01 |

**Reverse direction (wFIAT → USD):**

| In | Out |
|---|---|
| 1,450 wARS | 0.8785 USDT (fine) |
| 5.3 wBRL | 0.026 USDT |
| 530 wBRL | 0.026 USDT |

The two wBRL quotes are identical because the price hits the limit at MAX_SQRT. **The wBRL pool cannot be sold into**, so refunds or off-ramps from wBRL to USD via Uniswap are impossible today.

### Price compared with off-chain FX

| Pool | Pool rate | Off-chain rate (2026-11-02) | Gap |
|---|---|---|---|
| wARS | 1 USDT = 1650.2 wARS | **"dólar cripto"** 1652.6 / 1659.4 (dolarapi). Official rate: ~1535 (bluelytics/awesomeapi), 1515 / 1565 (dolarapi oficial) | Matches the crypto rate, ~7.5% above the official rate |
| wBRL | 1 USDT = 5.319 wBRL | ~5.437 (awesomeapi / frankfurter / br.dolarapi) | **~2.2% worse than market for the payer** |

## 6. Celo fee abstraction [on-chain]

- FeeCurrencyDirectory = `0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276`. Read via `cast call 0x000000000000000000000000000000000000ce10 "getAddressForStringOrDie(string)(address)" FeeCurrencyDirectory`.
- The list comes from `getCurrencies()`. Each entry's config comes from `getCurrencyConfig(addr)`, which returns (oracle, intrinsicGas). The oracle is `0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33` for all entries.

| feeCurrency value to use | Symbol | intrinsicGas | Underlying token |
|---|---|---|---|
| `0x765DE816845861e75A25fCA122bb6898B8B1282a` | USDm | 50000 | itself |
| `0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73` | EURm | 50000 | itself |
| `0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787` | BRLm | 50000 | itself |
| `0x73F93dcc49cB8A239e2032663e9475dd5ef29A08` | XOFm | 50000 | itself |
| `0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72` | USD₮ **adapter** (18 dec) | 85000 | `getAdaptedToken()` = USDT `0x48065f…5e` |
| `0xD221812de1BD094f35587EE8E174B07B6167D9Af` | WETH | 90000 | itself |
| `0x456a3D042C0DbD3db53D5489e98dFb038553B0d0` | KESm | 50000 | itself |
| `0x105d4A9306D2E55a71d2Eb95B81553AE1dC20d7B` | PHPm | 50000 | itself |
| `0x8A567e2aE79CA692Bd748aB832081C45de4041eA` | COPm | 50000 | itself |
| `0xfAeA5F3404bbA20D3cc2f8C4B0A888F55a3c7313` | GHSm | 50000 | itself |
| `0xCCF663b1fF11028f0b19058d0f7B674004a40746` | GBPm | 50000 | itself |
| `0x4c35853A3B4e647fD266f4de678dCc8fEC410BF6` | ZARm | 50000 | itself |
| `0xff4Ab19391af240c311c54200a492233052B6325` | CADm | 50000 | itself |
| `0x7175504C455076F15c04A2F90a8e352281F492F9` | AUDm | 50000 | itself |
| `0xb55a79F398E759E43C95b979163f30eC87Ee131D` | CHFm | 50000 | itself |
| `0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71` | NGNm | 50000 | itself |
| `0xc45eCF20f3CD864B32D9794d6f76814aE8892e20` | JPYm | 50000 | itself |
| `0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B` | USDC **adapter** | 128000 | `adaptedToken()` = USDC `0xcebA93…8C` |
| `0x0357EE22278c922e1D36cFe6b899269b161880C4` | USAT **adapter** | 85000 | `getAdaptedToken()` = USAT `0xD2ab3C…71` |
| `0x857BF24e29da0773687E804a743c2E421a394C16` | XAUt0 | 85000 | itself |

- **No wFIAT token (wARS, wBRL, …) is a fee currency.** Their bytecode also lacks `debitGasFees`.
- The USDC adapter uses `adaptedToken()`. The USDT and USAT adapters use `getAdaptedToken()`. Code that reads the underlying token must try both.
- Put the **adapter** address in the CIP-64 `feeCurrency` field. Use the token address for transfers.
- Docs: https://docs.celo.org/tooling/contracts/token-contracts

## 7. ERC-8004 (Trustless Agents) on Celo [on-chain + docs]

| Registry | Address | On-chain check |
|---|---|---|
| IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `name()` = "AgentIdentity", `symbol()` = "AGENT", `getVersion()` = "2.0.0"; ERC-1967 proxy → impl `0x7274e874ca62410a93bd8bf61c69d8045e399c02`; `ownerOf(1)` = `0x6446aD98…d161` |
| ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `getVersion()` = "2.0.0", `getIdentityRegistry()` = IdentityRegistry; impl `0x16e0fa7f7c56b9a767e34b192b51f921be31da34` |
| ValidationRegistry | `0x8004cc8439f36fd5f9f049d9ff86523df6daab58` | `getVersion()` = "2.0.0", `getIdentityRegistry()` = IdentityRegistry. The address came from the QuickNode explorer and is not in the Celo docs. |

Sources that list the same Identity and Reputation addresses:
- https://docs.celo.org/build/agents/8004
- https://github.com/erc-8004/erc-8004-contracts
- https://8004scan.io/networks
- The Celo Sepolia Identity registry is `0x8004A818BFB912233c491871b3d84c89A494BD9e` [docs].

**Functions** (selectors found in the implementation bytecode):

IdentityRegistry:
- `register()` `0x1aa3a008`
- `register(string agentURI)` `0xf2c298be`
- `register(string agentURI, (string metadataKey, bytes metadataValue)[] metadata)` `0x8ea42286`
- All three `register` overloads return `uint256 agentId`.
- `setAgentURI(uint256,string)`, `setMetadata(uint256,string,bytes)`, `getMetadata(uint256,string)`, `setAgentWallet(uint256,address,uint256,bytes)`, `tokenURI(uint256)`.

ReputationRegistry:
- `giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)` `0x3c036a7e`
- `getSummary(uint256,address[],string,string)`, `readFeedback(uint256,address,uint64)`, `revokeFeedback(uint256,uint64)`.

According to the Celo docs, `register()` sets the agent wallet to `msg.sender`. Feedback from the agent's own owner or operators is rejected.

**Spec:** https://eips.ethereum.org/EIPS/eip-8004 (status Draft; raw text at https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8004.md). `agentURI` can be `ipfs://`, `https://` or `data:application/json;base64,...`.

**Registration file format** (verbatim from the spec; `services` replaced the legacy `endpoints` in January 2026):

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "myAgentName",
  "description": "A natural language description of the Agent, which MAY include what it does, how it works, pricing, and interaction methods",
  "image": "https://example.com/agentimage.png",
  "services": [
    { "name": "web", "endpoint": "https://web.agentxyz.com/" },
    { "name": "A2A", "endpoint": "https://agent.example/.well-known/agent-card.json", "version": "0.3.0" },
    { "name": "MCP", "endpoint": "https://mcp.agent.eth/", "version": "2025-06-18" },
    { "name": "OASF", "endpoint": "ipfs://{cid}", "version": "0.8", "skills": [], "domains": [] },
    { "name": "ENS", "endpoint": "vitalik.eth", "version": "v1" },
    { "name": "DID", "endpoint": "did:method:foobar", "version": "v1" },
    { "name": "email", "endpoint": "mail@myagent.com" }
  ],
  "x402Support": false,
  "active": true,
  "registrations": [
    { "agentId": 22, "agentRegistry": "eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }
  ],
  "supportedTrust": ["reputation", "crypto-economic", "tee-attestation"]
}
```

**What 8004scan validates** (https://best-practices.8004scan.io/docs/01-agent-metadata-standard.html and `/docs/implementation/error-codes`):
- **Required fields:** `type`, `name`, `description` and `image`. `type` must equal the exact registration-v1 URI.
- **image:** must be an absolute URI (`https`, `ipfs`, `ar` or `data:`). 512x512 is recommended.
- **services:** must be a non-empty array.
  - The legacy `endpoints` field triggers warning WA031.
  - MCP `version` should be `"2025-06-18"`.
  - A2A `version` should be `"0.3.0"`, and its endpoint should point at `/.well-known/agent-card.json`.
  - An `agentWallet` endpoint must be CAIP-10.
- **Optional domain proof:** publish `https://{domain}/.well-known/agent-registration.json` containing a `registrations` entry.

## 8. `@celo/attribution-tags` (ERC-8021) [npm package read]

- **Version:** latest is **0.5.0**, published 2026-09-21. Earlier versions: 0.2.0, 0.3.0, 0.4.0.
  - Checked with `npm view @celo/attribution-tags --json`.
  - I downloaded the tarball `https://registry.npmjs.org/@celo/attribution-tags/-/attribution-tags-0.5.0.tgz` and read `dist/index.d.ts` and `README.md`.
- **Package metadata:** ESM only, Node ≥18. Depends on `ox ^0.14.12`. `viem ^2` is an optional peer dependency. Repo: https://github.com/celo-org/attribution-tags
- **Exports:**
  - `withAttribution`, `toDataSuffix`, `toRoleDataSuffix`, `fromDataSuffix`
  - `verifyTx`, `verifyUserOps`, `fromEntryPointCalldata`
  - `codeFromHostname`, `codeFromRepo`
  - `ERC_8021_MARKER`, `ENTRY_POINT_ADDRESSES`
  - Types: `AttributableClient`, `AttributionTagSuffix`, `DecodedSuffix`, `RoleCodes`, `TxClient`, `TxHash`, `UserOpAttribution`, `VerifyTxArgs`.

Signatures:

```ts
declare function withAttribution(code: string | readonly string[]):
  <C extends AttributableClient>(client: C) => Attributed<C>;
declare function toDataSuffix(code: string | readonly string[]): Hex;            // Schema 0
declare function toRoleDataSuffix(roles: { app?: string; wallet?: string; service?: string | readonly string[] }): Hex; // Schema 2
declare function fromDataSuffix(suffix: Hex): DecodedSuffix | null;
declare function verifyTx(args: { client: TxClient; hash: `0x${string}` }): Promise<DecodedSuffix | null>;
declare function codeFromHostname(hostname: string): string; // "celo_" + first 12 hex of sha256(lowercase, strip www.)
declare function codeFromRepo(repo: string): string;         // "celo_" + first 12 hex of sha256("owner/repo")
declare const ERC_8021_MARKER: "0x80218021802180218021802180218021";
```

Usage with a viem wallet client:

```ts
import { withAttribution, toRoleDataSuffix } from "@celo/attribution-tags";
const wallet = createWalletClient({ chain: celo, transport: http() }).extend(withAttribution("celo_xxxxxxxx"));
await wallet.writeContract({ address, abi, functionName: "pay", args }); // suffix auto-appended
```

- **What `withAttribution` wraps:** `sendTransaction`, `sendTransactionSync`, `writeContract` and `writeContractSync`.
- **Not wrapped:** `sendCalls` (EIP-5792). For that, use viem ≥2.45's client-level `dataSuffix`.
- **Wire format, Schema 0:** `[code bytes][len:1][0x00][marker 16 bytes]`. Several codes are comma-joined. Example: `0x63656c6f04 00 8021…8021` is the code "celo".
- **Wire format, Schema 2:** `[CBOR {a,w,s}][len:2][0x02][marker]`.
- **Allowed codes:** `[a-z0-9_]`, 1 to 32 bytes each, 255 bytes total.
- **For Cobrá's relayer:** the README says to use Schema 2 `toRoleDataSuffix({ app: <merchant/app code>, wallet: <relayer code> })` and `concat([calldata, suffix])` when submitting transactions on behalf of others.
- **Contract impact:** the suffix is appended after ABI calldata. The Cobrá router must not reject extra trailing calldata, which is fine for standard Solidity ABI decoding.

## 9. Ripio on/off-ramp link format [docs only]

Ripio's ramp is a **B2B partner widget**. You can't build a public prefilled link without a partner session token.

- Docs: https://docs.ripio.com/ramps-api/widget/get-started/launch and https://docs.ripio.com/ramps-api/widget/parameters
- **On-ramp URL:** `https://b2b-widget-onramp.ripio.com?_to=<authentication_token>`
- **Off-ramp URL:** `https://b2b-widget-onramp.ripio.com/offramp.html?_to=<authentication_token>`
- **Sandbox host:** `b2b-widget-onramp.sandbox.ripio.com`
- **Optional query parameters:**

| Parameter | Effect |
|---|---|
| `_addr` | Destination wallet, prefilled and not editable. Ignored if the user already has an address on file. |
| `_net` | Network, for example `ETHEREUM`. The value must match your partner networks. The Celo identifier is not documented publicly; get it from `GET /api/v1/depositNetworks/`. |
| `_amount` | Fiat amount. |
| `_crypto` | Token, for example `USDT`. |
| `_la` | Language: es, es-rp, en or br. |
| `_tracking_session` | Your session id. |

- **No country parameter:** each partner account is tied to one country (AR / MX / CO / BR).
- **Redirect back:** one return URL is configured at onboarding. Ripio appends `external_ref, action, crypto_amount, token, network, deposit_address, fiat_amount, fiat_currency, fees, session_id, country_code`. Brazil PIX and gateway flows redirect without parameters, so use webhooks there.
- **Getting the `_to` token:** it is minted server-side with OAuth2 partner credentials (the Ramps API).
- **Unknown:** whether wARS/wBRL on Celo are enabled for a given partner account. Ripio's consumer app and the "no-cost ramp" offer may differ.

## 10. Free FX sources (all no-key, fetched 2026-11-02 with `curl`)

| Source | Endpoint | Sample response (trimmed) | Notes |
|---|---|---|---|
| DolarAPI (AR) | `https://dolarapi.com/v1/dolares/oficial` | `{"moneda":"USD","casa":"oficial","compra":1515,"venta":1565,"fechaActualizacion":"2026-11-02T11:00:00.000Z"}` | Also `/v1/dolares/cripto`: `{"compra":1652.61,"venta":1659.35}`. This rate **matches the wARS pool**. Also `/blue` and `/bolsa` (MEP). |
| Bluelytics (AR) | `https://api.bluelytics.com.ar/v2/latest` | `{"oficial":{"value_avg":1535.50,"value_sell":1562.00,"value_buy":1509.00},"blue":{"value_avg":1548.50,...},"last_update":"2026-11-02T11:30:51-03:00"}` | |
| AwesomeAPI (BR) | `https://economia.awesomeapi.com.br/json/last/USD-BRL,USD-ARS` | `{"USDBRL":{"bid":"5.437","ask":"5.4383","create_date":"2026-11-02 08:56:43"},"USDARS":{"bid":"1535.5303",...}}` | Both currencies in one call. Free tier is rate-limited. |
| DolarAPI (BR) | `https://br.dolarapi.com/v1/cotacoes/usd` | `{"moeda":"USD","compra":5.4362,"venda":5.4364,"dataAtualizacao":"2026-10-30T00:00:00.000Z"}` | Updates daily. |
| Frankfurter (ECB) | `https://api.frankfurter.dev/v1/latest?base=USD&symbols=BRL` | `{"amount":1.0,"base":"USD","date":"2026-10-30","rates":{"BRL":5.4325}}` | Has **no ARS**. Business days only. |
| ExchangeRate-API open | `https://open.er-api.com/v6/latest/USD` | `{"result":"success","time_last_update_utc":"Mon, 02 Nov 2026 00:02:31 +0000","rates":{"ARS":1537.3487,"BRL":5.43...}}` | Daily. Attribution required. |
| fawazahmed0 currency-api (jsDelivr) | `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json` | `{"date":"2026-11-01","usd":{"ars":...,"brl":5.4...}}` | Daily CDN. |
| CriptoYa (AR, USDT/ARS by exchange) | `https://criptoya.com/api/usdt/ars/1` | `{"ripio":{"totalAsk":1671.88,"totalBid":1620.99},"binancep2p":{"totalAsk":1650.9,"totalBid":1644.01},...}` | Includes Ripio's own USDT/ARS price. Good for "crypto dollar" quotes. |

For ARS, display both the official and the crypto rate. The on-chain wARS price follows the **crypto/MEP dollar (~1650)**, not the official rate (~1535–1565).

---

## Surprises and blockers

1. **USDT and USAT on Celo support EIP-3009** (`receiveWithAuthorization` and `transferWithAuthorization`, including the bytes/ERC-1271 variants), as USDC does. All three USD payer tokens can use the single-signature EIP-3009 path, so Permit2 is only needed for USDm or arbitrary tokens.
   - USDT's domain is name "Tether USD", version "1". The contract has no `version()` getter and no EIP-5267, so hardcode it.
   - USDC's domain is name "USDC", version "2".
2. **wFIAT tokens have no EIP-3009.** They have EIP-2612 `permit` only, with domain (name(), "1", 42220, token). That only matters if a payer pays in wFIAT.
3. **The wBRL/USDT pool is one-sided**: 147k wBRL against 23 USDT, about $27.7k TVL.
   - Buying wBRL (USDT → wBRL) works: ~0.13% impact at $500 and ~1.25% at $5k.
   - Selling wBRL to USD via Uniswap is impossible.
   - The pool rate (5.319) is **~2.2% worse than market** (5.437).
4. **The wARS/USDT pool is healthy**: ~$106k TVL, 0.01% fee, 0.27% impact at $5k. It prices at the crypto dollar (~1650 ARS/USD), not the official rate.
5. **wMXN, wCOP, wCLP and wPEN have no Uniswap V3 pools at all** against USDT, USDC, USAT or USDm. Supplies are tiny (wPEN ≈ 603 tokens). Only wARS and wBRL can be swapped into via Uniswap today.
6. **There are no wFIAT/USDC pools.** USDC payers need a two-hop route, USDC → USDT (0.01%) → wFIAT. It works: 825k wARS cost 499.39 USDC.
7. **The router is SwapRouter02**: no `deadline` in the params structs, and `WETH9()` = 0 on Celo. Enforce deadlines in Cobrá's router or use `multicall(uint256 deadline, bytes[])`.
8. **No wFIAT is a Celo fee currency.**
   - Gas can be paid in USDC (adapter `0x2F25…602B`), USDT (adapter `0x0E2A…6f72`), USAT (adapter `0x0357…80C4`) or USDm.
   - Adapters report 18 decimals.
   - The underlying getter name differs between adapters: `adaptedToken()` for USDC, `getAdaptedToken()` for USDT/USAT.
9. **Upgradeable tokens everywhere.**
   - wFIATs are UUPS contracts with PAUSER, COMPLIANCE and UPGRADER roles. A blocklist exists but is currently off (`enforceBlocklist()` = false).
   - USDC and USDT have active blocklists.
   - An immutable Cobrá router should handle reverts gracefully.
   - There is no fee-on-transfer anywhere.
10. **The Ripio ramp needs a B2B partner account.** The widget only works with a server-minted `_to` token; there is no public deep link. There's no country URL parameter (accounts are per-country), and the Celo `_net` identifier is not publicly documented.
11. **Smaller notes:**
    - USDT's on-chain symbol is `"USD₮"`, not `"USDT"`.
    - The USDm EIP-712 domain name/version could not be identified; its domain separator matches none of the obvious candidates.
    - The ERC-8004 ValidationRegistry address came only from the QuickNode explorer, although the on-chain call confirms it.

### Unverified items
- USDm EIP-712 name and version.
- The Ripio `_net` value for Celo, and whether wFIAT on Celo is available to partner accounts.
- The UniversalRouter address (docs only; no bytecode check).
- Whether the wMXN, wCOP, wCLP and wPEN implementations have exactly the same source as wARS. I inferred it from identical bytecode length and selector set; only wARS source was read.
- Liquidity on other DEXes (Textile FX, Mento, Velodrome-style AMMs) was not checked. Celo's blog names Textile FX as a day-one wARS/wBRL FX venue.
