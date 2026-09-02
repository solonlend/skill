# Solon — Agent Integration Guide

**The bank an AI agent runs by itself.** Borrow USDG against tokenized US stocks on Robinhood Chain, by calling immutable public contracts directly. No frontend, no account, no server of ours in the loop.

This guide documents every Morpho module Solon is built on, module by module, in three moves:
**READ** (what to look at) · **VERIFY** (how to prove it's the official, unmodified deployment) · **USE** (the exact calls).

Solon writes ~80 lines of its own on-chain code (one oracle adapter). Everything else here is audited open-source Morpho, already live on Robinhood Chain. An agent that trusts nothing can verify all of it from this file plus `eth_call` / `eth_getCode`.

- Chain: Robinhood Chain — Arbitrum Orbit L2, `chainId 4663` (`0x1237`)
- RPC: `https://rpc.mainnet.chain.robinhood.com/rpc`
- Explorer: `https://robinhoodchain.blockscout.com`
- Gas token: ETH · Machine doc: `https://solonlend.xyz/llms.txt`
- Facts below verified on-chain 2026-09-03. `<TBD>` = Solon contract set at deploy (M1).

> **Access policy (read first).** Solon is not offered to persons/entities in the United States, China, or sanctioned jurisdictions. By interacting — via any frontend, direct call, or autonomous agent — you represent you are not a restricted person. Circumventing geo-restriction is a knowing violation by the accessing party; applies equally to human and agent.

---

## §0 · Address book (Robinhood Chain 4663)

Every address below has non-empty bytecode on 4663 (`eth_getCode` verified). Source: `morpho-org/sdks → blue-sdk/src/addresses.ts` (ChainId.RobinhoodMainnet), cross-checked on-chain.

| Contract | Address | Role |
|---|---|---|
| **Morpho Blue (core)** | `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010` | the lending primitive (all markets) |
| **AdaptiveCurveIRM** | `0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1` | the interest-rate model (only enabled IRM) |
| **MorphoChainlinkOracleV2Factory** | `0xB7c16F6F8cF531447Bf27Ca7220f981E79C9cdF2` | deploys oracle instances |
| **VaultV2Factory** | `0x0FBad98595b0186dA120E41f77C102beb49f803c` | deploys curated vaults (see §4 — RH uses **Vault V2**, not MetaMorpho v1.1) |
| **VaultV2 Blue PublicAllocator** | `0xCe5c1aFa115fF8b1D6913509bfc79D9AE08CC857` | on-demand cross-market liquidity |
| **MorphoMarketV1 Adapter-V2 Factory** | `0x79370Ed003CE325C088E530d5e8655c99c2993e1` | Vault V2 → Morpho-market adapter |
| **MorphoVaultV1 Adapter Factory** | `0x7a91222F3f7B927bB8fb624593Ca86e111C2F85e` | Vault V2 → vault-v1 adapter |
| **Bundler3** | `0x6478e9393d4C5bB4d53ee881d1DE78786A0344a6` | atomic multicall bundler |
| **GeneralAdapter1** | `0xc5E188541D107e8B79e43478bDE365F1406665D6` | Bundler3's ERC20/4626/Morpho adapter |
| **PreLiquidationFactory** | `0x0B0cFa151c06d2342799267754b0a2c320C43D5B` | opt-in softer liquidation params |
| **Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | canonical gasless approvals |
| **RegistryList** | `0xe785a2eFD384BA7B95BaEd3851BC76aeD67C676f` | Morpho on-chain registry |
| **wNative (WETH)** | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | wrapped ETH |
| Core governance (`owner()`) | `0x060595638692de6ccd47ca04094f1772d3d39728` | can only enable IRM/LLTV, set fee ≤25% |
| Loan token — **USDG** | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` | 6 decimals |

**Solon contracts (M1):** `solon_usdg_vault: <TBD>` · `oracle_adapter_*: <TBD>` · `fee_recipient: <TBD>`.

---

## §1 · Morpho Blue core — the lending primitive

One immutable singleton holds every market. `morpho-org/morpho-blue`, GPL-2.0. On 4663 the deployed runtime is 15,583 bytes.

### Structs
```solidity
struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }
struct Market   { uint128 totalSupplyAssets; uint128 totalSupplyShares; uint128 totalBorrowAssets; uint128 totalBorrowShares; uint128 lastUpdate; uint128 fee; }
struct Position { uint256 supplyShares; uint128 borrowShares; uint128 collateral; }
type Id is bytes32;
```
**Market id** = `keccak256(abi.encode(MarketParams))` (all five fields are 32-byte words, so it's a plain keccak over the 160-byte struct). Compute it yourself; never trust a supplied id blindly.

### READ — the view surface
```solidity
market(Id) -> Market            // totals, lastUpdate, fee
position(Id, address) -> Position   // your supplyShares, borrowShares, collateral
idToMarketParams(Id) -> MarketParams
owner() -> address              // governance
feeRecipient() -> address       // protocol fee sink (0x0 on 4663 today = fee OFF)
isIrmEnabled(address) -> bool
isLltvEnabled(uint256) -> bool
isAuthorized(authorizer, authorized) -> bool
nonce(address) -> uint256
DOMAIN_SEPARATOR() -> bytes32   // for setAuthorizationWithSig (EIP-712)
```
`totalSupplyAssets`/`totalBorrowAssets` are stale until `accrueInterest` — for exact live figures, call `accrueInterest(marketParams)` first (or simulate accrual off-chain with the IRM, §2). `market()` returns the last-checkpoint values.

### VERIFY — is this the real, unmodified core?
- **Immutable, no proxy.** Blue core has no admin upgrade path, no `delegatecall` upgrade, no implementation slot. `eth_getCode` and confirm it is not an EIP-1167/1967 proxy.
- **Bytecode diff.** `forge build` the audited tag of `morpho-org/morpho-blue`, strip trailing CBOR metadata, compare runtime bytecode to `eth_getCode`. Blue core takes no immutable constructor args → expect a byte-for-byte match.
- **Governance is minimal.** `owner()` = `0x0605…9728`. The owner can ONLY: `enableIrm`, `enableLltv`, `setFee` (capped `MAX_FEE = 0.25e18` = 25% of interest), `setFeeRecipient`, `setOwner`. It **cannot** pause, seize funds, upgrade, or change an existing market's params. Confirm there is no other admin.
- Audits: OpenZeppelin (2023-10), Cantina managed + competition (2023–24), Certora formal specs in-repo.

### USE — the raw calls (agent calls core directly)
Amounts: pass **`assets = X, shares = 0`** to specify an exact token amount; pass **`assets = 0, shares = myShares`** to close a position exactly (no dust). Exactly one must be zero.
```solidity
// borrow USDG against stock collateral:
collateralToken.approve(CORE, collat)
CORE.supplyCollateral(marketParams, collat, onBehalf=you, data=0x)
CORE.borrow(marketParams, assets=usdgAmt, shares=0, onBehalf=you, receiver=you)

// repay + reclaim:
USDG.approve(CORE, repayAmt)
CORE.repay(marketParams, assets=repayAmt, shares=0, onBehalf=you, data=0x)
CORE.withdrawCollateral(marketParams, collat, onBehalf=you, receiver=you)

// full repay with no dust: repay(marketParams, 0, position.borrowShares, you, 0x)
```
Shares math (`SharesMathLib`): `VIRTUAL_SHARES = 1e6`, `VIRTUAL_ASSETS = 1`; `assets→shares = assets*(totalShares+1e6)/(totalAssets+1)` and inverse. Virtual seeding makes first-depositor share manipulation impossible.

**Events to watch** (compute your own health each block, act before it crosses 1):
`CreateMarket(Id indexed, MarketParams)` · `Supply/Withdraw/Borrow/Repay(Id indexed, …)` · `SupplyCollateral/WithdrawCollateral(Id indexed, …)` · `Liquidate(Id indexed, caller indexed, borrower indexed, repaidAssets, repaidShares, seizedAssets, badDebtAssets, badDebtShares)` · `AccrueInterest(Id indexed, prevBorrowRate, interest, feeShares)`.
Note: the public RPC caps `eth_getLogs` by **result size**, not block range (RH is ~130 logs/block). Filter by `topic0` + `address` and page in windows that return bounded result sets.

---

## §2 · AdaptiveCurveIRM — the interest-rate model

`0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1`. Verified: `isIrmEnabled == true`, and it's the IRM referenced by every live market on 4663. `morpho-org/morpho-blue-irm`.

### READ
```solidity
borrowRateView(MarketParams, Market) -> uint256   // per-second rate, WAD (1e18) — view, no state change
rateAtTarget(Id) -> int256                          // stored per-market rate at 90% utilization, WAD/sec
MORPHO() -> address                                 // must equal CORE
```
`borrowRate(...)` (non-view) may be called only by CORE. Convert to APR: `apr = ratePerSecond/1e18 * 365*24*3600`.

### VERIFY
Confirm `market.irm == AdaptiveCurveIRM` (the address above) and `core.isIrmEnabled(irm) == true`. `MORPHO()` must equal the core. Audited: OpenZeppelin 2023-09, Cantina 2023–24, plus a 2025-11 Blackthorn + Spearbit re-audit and Certora specs.

### USE — predict the APR yourself
Constants (WAD): `TARGET_UTILIZATION = 0.90`, `CURVE_STEEPNESS = 4×`, `ADJUSTMENT_SPEED = 50/yr`, `INITIAL_RATE_AT_TARGET = 4%/yr`, bounds `MIN = 0.1%/yr`, `MAX = 200%/yr`.
1. Read `R* = rateAtTarget[id]` and utilization `U = totalBorrowAssets / totalSupplyAssets`.
2. Normalized error: `e = (U−0.9)/(1−0.9)` if `U ≥ 0.9`, else `e = (U−0.9)/0.9` (range −1…+1).
3. Instantaneous borrow rate: `rate = R* × (1 + (k−1)·e)`, with `k = 4` above target (up to `4·R*` at 100% util) and `k = 1/4` below (down to `R*/4` at 0% util).
4. Over time `R*` itself drifts exponentially toward equilibrium at 50/yr while `U ≠ 90%` (clamped MIN…MAX). For short horizons treat `R*` as constant. Instantaneous envelope: **0.025%/yr … 800%/yr**.

This is why a market pinned at 100% utilization shows a very high, rising APR — the curve is doing its job pushing suppliers in / borrowers out.

---

## §3 · Oracle — pricing (the one place Solon adds code)

### READ
```solidity
IOracle.price() -> uint256
```
Returns **the price of 1 unit of collateral quoted in the loan token**, scaled by `1e(36 + loanDecimals − collateralDecimals)`. For USDG (6) loan vs stock (18) collateral → scale = `1e24`.

### VERIFY
- The oracle behind a market is `market.oracle`. Confirm it was produced by the canonical `MorphoChainlinkOracleV2Factory` (`0xB7c1…cdF2`) — the factory tracks its instances.
- **Solon's adapter** (`oracle_adapter_*`, ~80 lines, GPL-2.0, byte-diffable): reads the Chainlink stock feed (which is already a *Total Return Value* — it already includes the `uiMultiplier`, so the adapter does **not** multiply again — "branch A"), divides by the USDG/USD feed so a USDG depeg tightens borrowing, and normalizes to the `1e36` target. Pool price is **never** used for pricing → flash-loan / thin-pool manipulation has no lever. Re-derive the scale from `decimals()` and check it matches.
- **fail-closed**: `price()` reverts if either feed is stale (`updatedAt` beyond bound), `answer <= 0`, `roundId == 0`, or `answeredInRound < roundId`.
- Weekend/holiday: US market closed → feed freezes → conservative LLTV + staleness bound + a market-hours keeper cover it. Documented risk, not a surprise.

### USE — health & liquidation math
```
value_in_USDG  = collateral × price() / 1e36                 // collateral base units → USDG base units
maxBorrow      = value_in_USDG × LLTV / 1e18
healthFactor   = maxBorrow / debt                            // >1 healthy; liquidatable when debt > maxBorrow
liquidationPrice = the collateral price at which healthFactor = 1
```
Use `@morpho-org/blue-sdk` `Position`/`AccrualPosition` for exact arithmetic — don't hand-roll decimals in production.

---

## §4 · Vault layer — where depositors earn (⚠ RH uses Vault V2)

A curated ERC-4626 vault takes USDG deposits and lends across chosen Morpho markets; depositors earn borrower interest minus a curator fee. **Solon's vault is this layer.**

**Important:** Robinhood Chain does **not** ship the classic `MetaMorphoFactory` (v1.1). The registry has **no** MetaMorpho factory for 4663. The curated-vault stack on RH is **Morpho Vault V2** (`VaultV2Factory 0x0FBa…803c` + the two adapter factories in §0). Vault V2 is still ERC-4626 but has a different role model (owner / curator / allocator / sentinel + adapter contracts) and a different function set than MetaMorpho v1.1. **Solon's `solon_usdg_vault` will be a Vault V2 instance.**

### READ (ERC-4626, common to both)
```solidity
deposit(assets, receiver) / mint(shares, receiver)
withdraw(assets, receiver, owner) / redeem(shares, receiver, owner)
totalAssets() · convertToShares(a) · convertToAssets(s) · maxDeposit/maxWithdraw
```
Vault V2 governance/config getters (owner, curator, allocator, per-market caps/queues, fee, timelock) — **exact V2 interface is a separate documentation pass** (`morpho-org/vault-v2`); do not assume v1.1 signatures. For reference, MetaMorpho v1.1 semantics are: cap **increase = timelocked, decrease = immediate**; `MIN_TIMELOCK = 1 day`, `MAX_TIMELOCK = 2 weeks`; `MAX_FEE = 0.5e18`; fee is a % of accrued interest minted to `feeRecipient`.

### VERIFY (the critical caveat)
"Official factory" guarantees only that the vault **shell** is canonical. It does **not** vouch for that vault's risk config. For **any** vault, independently audit: `owner`, `curator`, `guardian`/`sentinel`, `timelock`, and **every** market in its supply/withdraw queues and caps. A canonical shell with a malicious curator can still route your deposit into a bad market (within timelock rules). Confirm the factory recognizes it (`isVault`-style check) **and** read the config.

### USE — yield model
`supplyAPR ≈ Σ_i borrowAPR_i × utilization_i × weight_i × (1 − fee)`. No borrowers → no yield. Early weeks: low utilization = thin APY — state it honestly on-screen.

---

## §5 · Periphery

- **Bundler3** (`0x6478…44a6`) + **GeneralAdapter1** (`0xc5E1…65D6`): `multicall(Call[])` executes approve → supplyCollateral → borrow (etc.) **atomically** in one tx; supports flash-callback reentry for zero-capital flows. Only `bundler3` + `generalAdapter1` are deployed on 4663 (no Paraswap/migration adapters).
- **PublicAllocator** (Vault V2 variant, `0xCe5c…C857`): pulls liquidity from configured source markets into a target market on demand (subject to per-pair flow caps + a small fee), so a large borrow succeeds in one tx without merging isolated markets.
- **PreLiquidationFactory** (`0x0B0c…3D5B`): deploys per-market `PreLiquidation` contracts letting a borrower opt into softer liquidation params before the hard-LLTV breach.

---

## §6 · SDKs (`@morpho-org/*`)

| Package | Use it for |
|---|---|
| `@morpho-org/blue-sdk` | pure entity math — `Market`, `Position`, `AccrualPosition`, `MarketParams`; also the on-chain **address registry** |
| `@morpho-org/blue-sdk-viem` | viem fetchers — pull `Market`/`Position`/`Vault` state on-chain |
| `@morpho-org/blue-sdk-ethers` | ethers.js counterpart |
| `@morpho-org/evm-simulation` | simulate a tx's effect before sending (renamed `simulation-sdk`) |
| `@morpho-org/morpho-sdk` | newer high-level wrapper over the above |
| `@morpho-org/blue-api-sdk` | typed GraphQL client for the Morpho API |
| `@morpho-org/bundler-sdk-viem` | build Bundler3 call bundles (auto-wraps approvals/transfers) |
| liquidation SDK | `liquidation-sdk-viem` / `blue-liquidation-sdk` (confirm canonical before pinning) |

GraphQL API: `https://api.morpho.org/graphql` (indexes all chains incl. 4663 — use it to enumerate markets/vaults instead of brute-forcing logs).
An agent can go **SDK-free**: this file's addresses + ABIs + raw calls are enough. SDKs are a convenience, not a dependency.

---

## §7 · "Is this really the official Morpho?" — one checklist

1. `eth_getCode(core)` → not a proxy; runtime bytecode == `forge build` of the pinned Blue tag (minus CBOR metadata).
2. `core.owner()` == `0x0605…9728`; confirm the owner's only powers are enable-IRM / enable-LLTV / set-fee(≤25%) / set-fee-recipient / set-owner. No pause, no seize, no upgrade.
3. `market.irm` == AdaptiveCurveIRM (§0) and `isIrmEnabled == true`; `market.lltv` in the enabled set and `isLltvEnabled == true`.
4. `market.oracle` came from `MorphoChainlinkOracleV2Factory`; re-derive its `1e36` scale from decimals.
5. Vault: recognized by `VaultV2Factory` **and** its owner/curator/queues/caps independently audited (§4). The shell being canonical ≠ the config being safe.

Blue core & IRM are immutable and audited; **vault curators and market creators are the trust surface** — that's where an agent spends its scrutiny.

---

## §8 · Live worked example — TSLA → USDG (real, on-chain now)

A stock→USDG market already exists on RH (created permissionlessly on Morpho core — proof the rails work today; Solon curates and packages them):
```
marketParams = {
  loanToken:       0x5fc5360d0400a0fd4f2af552add042d716f1d168  // USDG (6dec)
  collateralToken: 0x322F0929c4625eD5bAd873c95208D54E1c003b2d  // TSLAx (18dec)
  oracle:          0x280855A5BF983bf005f19992C157007930B3de2A  // MorphoChainlinkOracleV2 instance
  irm:             0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1  // AdaptiveCurveIRM
  lltv:            770000000000000000                          // 77%
}
id = 0xf4dff250826a86627545e5c6594b3b249db3ad2ec5eed56c02833d2a67acf445
```
Live state (2026-09-03): `oracle.price()` → **$352.97 USDG / TSLA** · supply ≈ $15 · borrow ≈ $12 · utilization **79.2%** · borrow APR **1.18%** · fee 0.
Math check — 1 TSLA of collateral: `value = 1e18 × price / 1e36 = $352.97`; `maxBorrow = 352.97 × 0.77 = $271.79 USDG`; borrow $200 → `health = 271.79/200 = 1.36`; liquidation when TSLA falls to `200 / (1 × 0.77) = $259.74`.
An agent can reproduce every number above from `market(id)`, `position(id,me)`, `oracle.price()`, and `borrowRateView`.

---

## §9 · Agent safety rules (non-negotiable)

- Use a **dedicated wallet** holding only this session's funds. Blast radius = that wallet.
- **Never** put a private key in a prompt or config string. env / keystore / external signer only.
- Subscribe to core events and manage your **own** health; there is no hosted push service.
- Contracts are immutable — rules won't change under you (CODE IS LAW). Verify addresses against §7 before sending value.
- Verify the market/vault config **before** the first tx, not after.

*Built on Morpho Blue (GPL-2.0). "Built on Morpho" is nominative use — not affiliated with or endorsed by Morpho. Solon's only new on-chain code is the ~80-line StockOracleAdapter (open, byte-diffable).*
