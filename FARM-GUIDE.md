# Solon — Leveraged LP Farm Integration Guide

Extension of **AGENT-GUIDE §10**, in the same **READ → VERIFY → USE** order. This covers both single-asset and Dual-Borrow farm interfaces; §§0–9, Morpho certification, the USDG-only lending restriction and the historical “only StockOracleAdapter is new code” statements describe the **lending side**. They do not describe these additional Solon contracts. Do not apply Morpho ABIs, market ids, approvals or audit/immutability claims to a farm.

> **Access policy.** Solon is not offered to persons/entities in the United States, China, or sanctioned jurisdictions; this applies equally to direct calls and autonomous agents. Do not bypass restrictions. **Leveraged LP positions can be liquidated and lose funds.** Use a dedicated wallet, keep keys outside prompts/config strings, and monitor your own positions; there is no hosted push service.

## Product and contracts

**Dual-Borrow leveraged LP:** invest and borrow each asset separately — WETH (RISK) + USDG (LOAN) — in the proportions required by a Uniswap V3/V4 concentrated-liquidity range. LP fees are revenue; interest on **both** reserves and protocol fees are costs. This differs from the stock-collateral loan in the lending guide.

**Dual-Borrow** open and increase perform **zero swaps**. Close returns LP assets and repays each matching debt leg, with zero swaps **when both legs cover repayment, including any wallet top-ups**. A deficit can invoke a swap; “zero-swap open/close” is not an unconditional close guarantee. Use `maxSwapIn=0` and enough top-ups for a no-swap close, then simulate.

| Contract | Responsibility |
|---|---|
| `UniV3DualVault` | First-launch target: holds V3 LP NFTs, records two debt ids per receipt and manages open/close, margin, range, fees and permissioned liquidation. |
| `UniV4DualVault` | Equivalent dual-debt lifecycle on V4 PositionManager/StateView, with different mint/increase tuples; select its own ABI. |
| `UniV3LeverageVault` / `UniV4LeverageVault` | Single-asset versions invest/borrow LOAN and zap into LP; one debt id. Use the single-asset READ and USE sections below with their own ABIs. |
| `LendingPool` | Separate farm lending engine with WETH and USDG reserves, per-reserve interest/credit controls and debt accounting; not Morpho Blue. |
| `LpShareOracleV4` | Values LP and risk debt from external feeds with separate risk/stable staleness bounds and a USDG depeg band; also used by the V3 dual vault. |
| `SwapExecutorV3` | Adapts vault gap/delta swaps to V3 SwapRouter02 exact-input/exact-output routes and refunds unused input. |

## READ — resolve the position, debt and price

Load `addresses.json.leveragedFarms` and `abis/FARM-ABI-SOURCES.json`; pick the chain and exact vault shape. **Mainnet farm addresses are `<TBD>`: stop before approvals or transfers.** Sepolia is an explicitly selected test-only example, chainId **11155111**, using mocks; never fall back to it from 4663. The top-level address-book `verifiedAt` covers the pre-existing lending snapshot, not the new farm records.

The shipped ABIs include complete single-asset and dual-vault interfaces, LendingPool, oracle and executor plus minimal compiled pool/feed interfaces. All amounts are raw token units; read `decimals()` (WETH normally 18, USDG normally 6), never assume TOKEN0 is RISK. For dual vaults read `TOKEN0`, `TOKEN1`, `LOAN_IS_C0`, `RISK`, `LOAN`, `RESERVE_RISK`, `RESERVE_LOAN`, `ORACLE`, `LENDING_POOL`, `SWAP_EXECUTOR`, `LLTV`, `MIN_WIDTH_TICKS` and fee getters.

```solidity
// UniV3DualVault (the receipt id is NOT dexTokenId or either debt id):
ownerOf(uint256 id) -> address
positions(uint256 id) -> (uint256 dexTokenId, uint128 liquidity,
    int24 tickLower, int24 tickUpper, uint256 debtRisk, uint256 debtLoan)
positionValue(uint256 id) -> uint256 valueInLoan
totalDebtInLoan(uint256 id) -> uint256
isHealthy(uint256 id) -> bool
LLTV() -> uint256                          // WAD, 1e18
previewClose(uint256 id, uint16 percent) -> (
    uint256 estGotRisk, uint256 estGotLoan, uint256 dueRisk, uint256 dueLoan,
    uint256 shortRisk, uint256 shortLoan)

// LendingPool; query BOTH reserve ids and BOTH debt ids:
getCurrentDebt(uint256 debtId) -> (uint256 currentDebt, uint256 latestBorrowingIndex)
getUnderlyingTokenAddress(uint256 reserveId) -> address
utilizationRateOfReserve(uint256 reserveId) -> uint256  // WAD
borrowingRateOfReserve(uint256 reserveId) -> uint256    // annual rate, WAD
totalLiquidityOfReserve(uint256 reserveId) -> uint256 // underlying units
totalBorrowsOfReserve(uint256 reserveId) -> uint256   // underlying units
reserves(uint256 reserveId)                   // config/flags/capacity; see ABI tuple
credits(uint256 reserveId, address vault) -> uint256
borrowingWhiteList(address vault) -> bool
paused() -> bool
```

Use the current-debt views, not stored principal or stored `reserves.totalBorrows`. Utilization is borrows / total liquidity (including borrows); available reserve liquidity is total liquidity minus borrows. Borrow APR = `borrowingRateOfReserve / 1e18`; **do not multiply by seconds/year**, unlike the Morpho per-second IRM in §2. Respect reserve flags, capacity, vault whitelist and remaining credit as well as available cash; simulate the intended borrowing transaction.

For dual vaults, `positionValue` is gross LP fair value in LOAN base units (not equity, not a spot quote, and excluding uncollected trading fees). `totalDebtInLoan` = oracle-valued current risk debt + current loan debt. `previewClose` uses **pool spot** and LP principal, not uncollected fees; its per-leg dues include current interest and round up for a partial close. It is an estimate of shortages, not a guaranteed quote or a health oracle.

### Dual-Borrow health and two liquidation boundaries

```text
V = positionValue(id)
D = totalDebtInLoan(id)
capacity = floor(V * LLTV / 1e18)
health = D / (V * LLTV / 1e18)       // debt utilization: LOWER is safer
headroomInLoan = capacity - D        // signed; negative means liquidatable
```

**100% is the liquidation boundary.** The exact source condition is `isHealthy = capacity >= D`: equality remains healthy; permissioned liquidation is allowed only when `D > capacity`. This farm `health` is the reciprocal of the lending guide's capacity/debt health factor. Do not silently reuse its thresholds. For V=0 and D>0 treat health as infinite; V=D=0 is not an active healthy position — check `ownerOf` and debt ids. Example: V=10,000 USDG, LLTV=77%, D=6,000 USDG gives health≈77.92% and 1,700 USDG debt headroom; these are illustrative figures, not deployment parameters or a recommendation.

**Observed dual-borrow property: resistance to price movement inside the range; loss of that protection outside it.** With range-matched borrowing, LP collateral and debt values move together, so health is relatively stable in-range. Once price exits, LP becomes one-sided: above the WETH price range its USDG value caps while WETH debt keeps rising; below the range LP holds WETH whose USDG value falls while USDG debt remains. **Either direction can reach liquidation.** This is the project's on-chain/fork observation, not a mathematical guarantee of constant health or immunity within the range: mismatched debt ratios, interest, proximity to boundaries and feed/pool divergence still matter. Always use the live health check.

There is **no liquidation-price getter**. To estimate both prices, freeze current liquidity, ticks and debt quantities; for candidate P (USDG per WETH), recompute LP amounts using the same `FairLpMath`/`LiquidityAmounts` range math and feed-decimal conversion, then solve `dRisk * P + dLoan = V(P) * LLTV/1e18` in normalized token units. Search upward and downward separately, including beyond both range endpoints; a root need not exist on each side for every debt mix. Reproduce integer rounding at the boundary and include interest-growth scenarios. For TOKEN1/TOKEN0 price Q, `Q = 1.0001^tick * 10^(dec0-dec1)`; P=Q if RISK=TOKEN0, otherwise P=1/Q (invert and reorder endpoints). Do not derive health from `previewClose` or extrapolate a single fixed liquidation price from today's ratio.

Monitor feed rounds/age, pool tick, health, both APRs, owner and debt after every transaction and on new blocks. Set a wallet-funded margin policy below 100%, with enough time/asset headroom for execution. Near a boundary or a policy threshold, refresh state and prefer reducing debt with `addMargin`; an unhealthy position cannot necessarily rebalance or partially close because those paths enforce post-action health. Only addresses with `liquidators(keeper)==true` may call `liquidate`; an ordinary agent cannot liquidate others. `GOVERNOR` can change that whitelist. A burned receipt can retain residual debt — read both debt ids and `BadDebt` events even after full closure.

### Single-asset position, debt and health

Select `uni-v3-leverage-vault.json` or `uni-v4-leverage-vault.json`. Single-asset refers to **LOAN-only investment and borrowing**, not a one-token LP: the vault zaps into the two LP tokens. Read the common token/oracle/fee getters above, but use **RESERVE_ID()**, not RESERVE_RISK/RESERVE_LOAN; check only that borrowing reserve's cash, rate, flags and vault credit.

```solidity
// Both single-asset vaults:
ownerOf(uint256 id) -> address
nextPositionId() -> uint256
RESERVE_ID() -> uint256
LLTV() -> uint256
positionValue(uint256 id) -> uint256 valueInLoan
// V3:
positions(uint256 id) -> (uint256 dexTokenId, uint128 liquidity,
    int24 tickLower, int24 tickUpper, uint256 debtId)
// V4:
positions(uint256 id) -> (uint256 v4TokenId, uint128 liquidity,
    int24 tickLower, int24 tickUpper, uint256 debtId)
// Call LENDING_POOL, not VAULT:
getCurrentDebt(uint256 debtId) -> (uint256 currentDebt, uint256 latestBorrowingIndex)
```

Read these at the same block. Neither single-asset vault exposes `totalDebt`, `totalDebtInLoan`, `health`, `isHealthy` or `previewClose`; `_isHealthy` is internal. Compute **D = LENDING_POOL.getCurrentDebt(positions(id).debtId).currentDebt**, **V = VAULT.positionValue(id)** and **capacity = floor(V * LLTV / 1e18)** in LOAN raw units. Health utilization is D / (V * LLTV / 1e18), lower is safer; the exact healthy condition is **D <= capacity**, with equality healthy and liquidation allowed only for D > capacity. Apply the zero-value and active-owner checks above; a zero owner marks a nonexistent/burned receipt.

**Single-asset is classic leverage: price movement directly affects LP collateral value and health, even inside the range. It does not have the dual-borrow range-matched resistance to volatility.** Its debt is only LOAN plus interest; there is no risk-token debt whose value tracks the collateral. A risk-price fall can make it liquidatable while still in-range. Above the range the LP's LOAN value caps; interest can still erode headroom. Do not apply the dual two-boundary equation or promise two liquidation prices: for this shape solve D = V(P) * LLTV / 1e18 using the verified oracle's valuation model and debt-growth scenarios. There is no liquidation-price getter.

Both single-asset vaults use permissioned standard liquidation: a whitelisted keeper funds LOAN repayment capped at floor(currentDebt * CLOSE_FACTOR_BPS / 10000), seizes proportional LP with LIQ_BONUS_BPS, and receives consolidated LOAN subject to minSeizeOut and protocol fees. Excess proceeds first repay remaining debt, then return to the borrower. Read BadDebt and the saved debtId after a burn. Neither single-asset vault has `addMargin` or `rebalance`; do not suggest the dual addMargin rescue path. `increase` with amountBorrow=0 adds collateral through a zap rather than repaying debt, and must still pass post-action health. Partial close and either harvest mode also require post-action health. A wallet cannot repay the vault's debt directly via LendingPool: its repay requires msg.sender to be the debt-position owner (the vault).

### Oracle timeliness and USDG depeg

Read `FEED0`, `FEED1`, `LOAN_FEED`, `RISK_FEED`, `DEC0`, `DEC1`, `LOAN_DEC`, `RISK_DEC`, `RISK_MAX_STALENESS`, `STABLE_MAX_STALENESS`, `STABLE_DEPEG_BPS`. On each underlying feed read `decimals()` and `latestRoundData()` (roundId, answer, startedAt, updatedAt, answeredInRound). The oracle checks:

- Nonzero roundId/updatedAt, answeredInRound >= roundId, positive answer; future timestamps also fail arithmetic.
- `block.timestamp - updatedAt <= RISK_MAX_STALENESS` for the risk leg, and `<= STABLE_MAX_STALENESS` for LOAN_FEED.
- USDG/USD within `1 USD * (1 ± STABLE_DEPEG_BPS/10000)`, inclusive, in feed decimals; outside either bound reverts `StablecoinDepegged`.

Current source constructor bounds are risk **1–48 hours**, stable **25–48 hours**, depeg **10–500 bps**; these are allowed bounds, not live settings. RH ETH/USD is deviation-triggered with a long heartbeat: the project's 2026-09-06 sample observed a **24.01h maximum gap**, with more frequent updates during volatility and deviations around 0.5%. That is historical observation, not a guaranteed maximum or update SLA. The confirmed **LpShareOracleV4 target configuration is risk 26h (93600 seconds), stable 26h (93600 seconds), depeg 50bps (±0.5%; inclusive USDG/USD band $0.995–$1.005)**. Sources: `stocklend/leverage/docs/FINDING-rh-eth-feed-staleness-2026-09-06.md` (same-day correction) and `stocklend/leverage/DEPLOY-CHECKLIST.md` §1.10. The old 3h risk / 100bps depeg settings are superseded for configuration. The dated Sepolia record in addresses.json remains historical evidence, not the target or proof of current settings; verify actual getters and stop if the deployment differs from the intended configuration. Constructor bounds come from current source, not the checklist's stale inline guardrail note.

Fail closed when price reads fail: do not cache the last good health as current, substitute pool spot, or assume a quiet feed is necessarily working. A long staleness allowance also delays detection of a feed outage. Pause new/increased leverage and alert locally. For **dual vaults only**, `addMargin` repays tokens without reading the oracle, so it can still reduce debt. A fully funded **dual** full close with **zero** remaining risk shortage can avoid failed oracle reads; a nonzero risk shortage invokes the oracle even before top-up/dust handling, and partial close checks health. Single-asset close normally reads the oracle for the RISK→LOAN swap minimum and has no top-up/addMargin escape path. Verify the actual ORACLE implementation: both single-asset vaults require fairValueInLoan, zapAmountToToken0 and riskValueInLoan. The older LpShareOracle lacks riskValueInLoan; its name/import does not prove compatible wiring. Apply the split freshness/depeg getters only to verified LpShareOracleV4 deployments. Simulate the exact path; oracle failure is not permission to discard debt or disable guards.

## VERIFY — before the first value-moving transaction

Keep the pinned-commit and on-chain re-verification discipline of `VERIFY.md`; its Morpho-specific factory/owner checks do not certify farms.

1. Check `eth_chainId`, reject `<TBD>`, zero addresses and cross-chain records; fetch non-empty runtime bytecode for every vault/dependency/token/feed. The Sepolia example is transcribed from `stocklend/leverage/deployments/sepolia-2026-09-06.md`, not freshly verified here. This pass is offline.
2. Match deployed code to pinned deployment source/build, accounting for compiler settings, linked libraries, metadata and immutable constructor values; detect any proxy and verify its implementation/admin. Local current-source ABI provenance is in `abis/FARM-ABI-SOURCES.json`. A local artifact match does not prove the dated Sepolia deployment runs the same revision: the record says “based on a3549af”; verify before use.
3. Verify vault `GOVERNOR`, `POSITION_MANAGER`, `POOL` (V3), token ordering, `FEE`, reserves, oracle and executor wiring. Check the pool's actual tokens/fee/tick spacing and PositionManager/factory relationship; dual reserves' underlying tokens must match RISK/LOAN; for single-asset verify RESERVE_ID maps to LOAN. For V4 verify `POOL_ID`, `STATE_VIEW`, `TICK_SPACING`, `HOOKS` and the pool key against its manager; do not use V3 `slot0` on a V4 manager.
4. Read LLTV, minimum width, close factor, liquidation bonus, protocol and harvest fees. Inspect LendingPool owner/addressRegistry, pause state, reserve flags/rate config, borrowing whitelist and both dual credits (single-asset: RESERVE_ID credit). These are additional trust surfaces; do not inherit the lending core's limited-governance claims.
5. Verify feed identity/decimals and token mapping, both staleness settings, depeg band and successful fair-value reads. Verify executor `ROUTER`, `DEFAULT_FEE`, owner and the chosen route. Observe keeper whitelist changes; ABI presence is not permission to call admin/keeper functions.
6. Simulate from the actual caller, with intended allowances, bounded amounts/deadline and current state; only then approve/send. Re-read config before subsequent operations if mutable controls changed. No key, approval or transaction is needed to perform the read-only verification.

## USE — exact UniV3DualVault calls

These are source declarations (parameter order and integer widths matter); named structs below are documentation syntax, not an SDK dependency. Use `abis/uni-v3-dual-vault.json` to encode them. All entry points are nonpayable: wrap native ETH to WETH separately if needed, and retain ETH for gas.

```solidity
struct OpenParams {
    uint256 investRisk; uint256 investLoan;
    uint256 borrowRisk; uint256 borrowLoan;
    int24 tickLower; int24 tickUpper;
    uint256 amount0Min; uint256 amount1Min; uint128 minLiquidity;
    uint256 deadline;
}
function open(OpenParams calldata p) external returns (uint256 positionNftId);

struct CloseParams {
    uint16 percent;
    uint256 topUpRisk; uint256 topUpLoan;
    uint256 maxSwapIn;
    uint256 minOutRisk; uint256 minOutLoan;
    bytes zapPath; uint256 deadline;
}
function close(uint256 id, CloseParams calldata c) external returns (uint256 outRisk, uint256 outLoan);

struct IncreaseParams {
    uint256 investRisk; uint256 investLoan;
    uint256 borrowRisk; uint256 borrowLoan;
    uint256 amount0Min; uint256 amount1Min; uint128 minLiquidity;
    uint256 deadline;
}
function increase(uint256 id, IncreaseParams calldata p) external;
function addMargin(uint256 id, uint256 amountRisk, uint256 amountLoan) external;

struct RebalanceParams {
    int24 newTickLower; int24 newTickUpper;
    int256 swapAmount;
    uint256 minSwapOut; uint128 minLiquidity; bytes zapPath; uint256 deadline;
}
function rebalance(uint256 id, RebalanceParams calldata p) external;
function harvest(uint256 id, bool compound, uint256 deadline) external returns (uint256 out0, uint256 out1);
```

### Common execution and protection rules

Approve the **vault**, not LendingPool, PositionManager, executor or a Morpho adapter. Approvals cover only wallet investments/top-ups/repayments; the vault borrows directly and approves its dependencies internally. Check existing allowance; use bounded approval amounts (zero-reset first if required by the token). All position-changing calls except `addMargin` require `ownerOf(id)==msg.sender`; receipts are minimal ownership records, not freely transferable ERC-721s.

Use a fresh pool quote/simulation and a user-authorized slippage budget `s` bps: floor expected output/consumption/liquidity times `(10000-s)/10000` for minimums; ceil expected swap input times `(10000+s)/10000` for maximum input, also capped by the wallet's authorized loss budget. Never blindly zero every minimum. `amount0Min/amount1Min` are minimum **minted/added token consumption** in token0/token1 order; `minLiquidity` is the independent liquidity floor. Use short, explicit UNIX-second `deadline`s derived from latest block time, and refresh quotes after approvals. A simulation is not a mined-result guarantee.

### Open

1. Read spot tick, tick spacing, balances, both reserve rates/cash/credits and oracle health inputs. Choose aligned ticks with `tickLower < currentTick < tickUpper` and width >= `MIN_WIDTH_TICKS`.
2. Compute required token0/token1 LP ratio at spot for the selected range; choose `investRisk+borrowRisk` and `investLoan+borrowLoan` to match it and leave health headroom. No zap fixes an incorrect ratio.
3. `RISK.approve(VAULT, investRisk)` and `LOAN.approve(VAULT, investLoan)` as needed → simulate → `VAULT.open(p)` with quoted `amount0Min`, `amount1Min`, positive `minLiquidity` and deadline.
4. Get `id` from `PositionOpened` in the mined receipt (do not guess from `nextPositionId`). Read `positions`, both actual debts and health. Unused amounts first repay same-leg debt and remaining dust returns to the caller; borrow request amounts are not final debt balances.

### Close (partial or full)

1. Read `previewClose(id, percent)` with **1..10000 bps** (10000 = full; source treats >=10000 as full). For partial closes, ensure the rounded liquidity removal is nonzero.
2. Reserve top-ups for `shortRisk` and `shortLoan`, allowing for interest/price movement. Approve RISK/LOAN to VAULT up to `topUpRisk`/`topUpLoan`; only the needed non-dust amount is pulled. To require no swap, fill both deficits and set `maxSwapIn=0`, `zapPath=0x`.
3. If authorizing a gap swap, bound `maxSwapIn` in the **surplus input leg's raw units**: LOAN input for a RISK shortage, RISK input for a LOAN shortage. For an explicit exact-output `zapPath`, encode **tokenOut → fee → tokenIn** (reverse path); `0x` uses executor DEFAULT_FEE single hop.
4. Set `minOutRisk`/`minOutLoan` to protected final per-leg proceeds **after debt settlement**, based on simulation, not gross `previewClose` amounts. Zero is appropriate only for a leg with no required payout. Simulate → `VAULT.close(id,c)` → read remaining liquidity, both debts, owner and events.

Settlement is LP matching repayment → capped wallet top-ups → exact-output gap swap. If exact-output fails, the source permits whole-surplus exact-input fallback only when `maxSwapIn` covers that whole surplus; it forces the default route and a fixed **500bps oracle-based** minimum. This fallback is not a user-configurable tighter swap-slippage guarantee: final payout minima still apply. If that risk is unacceptable, use funded no-swap closure. Partial closes must leave healthy debt; full closes with material residual debt require an oracle-proven pre-existing insolvency, otherwise revert `SolventBadDebt`. Dust tolerance does not mean zero residual debt. Read `getCurrentDebt` on both saved debt ids after receipt burn, and use `addMargin` to repay remaining debt when possible; do not sum `PositionClosed.repaid*` as a complete settlement ledger (gap repayments occur separately).

### Increase

`RISK.approve(VAULT,p.investRisk)` + `LOAN.approve(VAULT,p.investLoan)` as needed → simulate → `VAULT.increase(id,p)`. This adds to the existing range and existing debt ids, without swaps. Set token0/token1 consumption minimums and `minLiquidity` for the **added** liquidity, not total position liquidity. Unused funds repay same-leg debt before refund; resulting position must be healthy. No tick fields or zap path exist in this tuple.

### Add margin / repay on behalf

`RISK.approve(VAULT,amountRisk)` + `LOAN.approve(VAULT,amountLoan)` as needed → `VAULT.addMargin(id,amountRisk,amountLoan)`. Either amount may be zero. This **repays debt**, does not add LP liquidity or swap, and caps each pull at current debt. It is deliberately callable by a third-party payer; there is **no fourth “on behalf” parameter** and no ownership transfer/reimbursement right. Confirm the target id before paying. It also accepts burned positions with recorded debt ids. No slippage or deadline parameters exist; simulate balances/allowances and check `MarginAdded` plus debt changes, then health if the oracle is available.

### Rebalance

No new wallet token approval: all input comes from the position. Read a two-sided, tick-aligned new range satisfying minimum width → quote optional delta swap → simulate → `VAULT.rebalance(id,p)`. Debt quantities/ids are not reborrowed or repaid by rebalance; interest continues. `swapAmount > 0` sells RISK for LOAN, `< 0` sells LOAN for RISK, `0` skips swap. Set `minSwapOut` from the exact-input quote; explicit paths run **tokenIn → fee → tokenOut**, or `0x` for default single hop. Set `minLiquidity` for the entire replacement LP and deadline. V3 removal/mint token minimums are internally zero here; the exposed protections are minSwapOut, minLiquidity and post-action health. Fees are collected/skimmed and dust refunded; track the new dexTokenId.

### Harvest

No wallet approval → simulate → `VAULT.harvest(id,compound,deadline)`. `compound=false` sends net token0/token1 fees to the holder; `true` reinvests both legs directly with no swap and refunds dust. `HARVEST_FEE_BPS` is skimmed first and post-action health is checked. **No `zapPath`, `minOut` or `minLiquidity` argument exists.** Compounding uses internal `amount0Min=amount1Min=0`; if execution without user-set minima is outside policy, claim fees instead of compounding. The deadline is passed to the liquidity-increase path, not enforced for claim-only execution. Returned `out0/out1` are set on claim; compound refunds should be reconciled using balances/events, not assumed from return values.

### V4 dual routing

The above parameter tuples are for **V3 dual only**. `abis/uni-v4-dual-vault.json` has `OpenParams` with **uint128 amount0Max, uint128 amount1Max**, not V3 amount0Min/amount1Min; its `IncreaseParams` omits both amount minimum fields and uses minLiquidity. Re-derive caps from that implementation; do not encode V3 tuples at V4 addresses. For single-asset vaults use the exact separate sequences below; never route a dual tuple to a single-asset address.

Watch vault `PositionOpened`, `PositionIncreased`, `PositionClosed`, `MarginAdded`, `Rebalanced`, `Harvested`, `PositionLiquidated`, `BadDebt`, `LiquidatorSet` and receipt `Transfer` events; re-read on-chain state after confirmation and handle reorgs. Use bounded topic/address-filtered log windows as in the lending guide.

## USE — exact UniV3LeverageVault / UniV4LeverageVault calls

Use the single-asset READ section and shared VERIFY checklist first. All calls below are nonpayable; wrap ETH separately and retain gas. Encode with `abis/uni-v3-leverage-vault.json` or `abis/uni-v4-leverage-vault.json`, selected by verified deployment shape. Amounts are raw token units; integer widths and field order are exact.

```solidity
// UniV3LeverageVault:
struct OpenParams {
    uint256 amountInvest; uint256 amountBorrow;
    int24 tickLower; int24 tickUpper;
    uint256 amount0Min; uint256 amount1Min;
    uint128 minLiquidity;
    bytes zapPath; uint256 deadline;
}
struct IncreaseParams {
    uint256 amountInvest; uint256 amountBorrow;
    uint256 amount0Min; uint256 amount1Min; uint128 minLiquidity;
    bytes zapPath; uint256 deadline;
}
```

```solidity
// UniV4LeverageVault (NOT the V4 dual IncreaseParams):
struct OpenParams {
    uint256 amountInvest; uint256 amountBorrow;
    int24 tickLower; int24 tickUpper;
    uint128 amount0Max; uint128 amount1Max;
    uint128 minLiquidity;
    bytes zapPath; uint256 deadline;
}
struct IncreaseParams {
    uint256 amountInvest; uint256 amountBorrow;
    uint128 amount0Max; uint128 amount1Max; uint128 minLiquidity;
    bytes zapPath; uint256 deadline;
}
```

```solidity
// Both single-asset vaults; OpenParams/IncreaseParams refer to their own version above:
function open(OpenParams calldata p) external returns (uint256 positionNftId);
function increase(uint256 id, IncreaseParams calldata p) external;
struct CloseParams {
    uint16 percent; uint256 minOutSingleToken; bytes zapPath; uint256 deadline;
}
function close(uint256 id, CloseParams calldata c) external returns (uint256 out);
function harvest(uint256 id, bool compound, bytes calldata zapPath, uint256 deadline)
    external returns (uint256 out0, uint256 out1);
struct LiquidateParams {
    uint256 repayAmount; uint256 minSeizeOut; bytes zapPath; uint256 deadline;
}
function liquidate(uint256 id, LiquidateParams calldata lp) external returns (bool fullyClosed);
```

### Common execution and protection rules

Only the holder can increase, close or harvest. Approve **LOAN to VAULT** for amountInvest; no wallet RISK approval or borrowed-amount approval is needed. V4's internal Permit2/PositionManager allowances are managed by the vault, not the wallet. Keep approvals bounded and refresh simulation after approval. Single-asset open/increase swap **LOAN→RISK**, and close/liquidation consolidate **RISK→LOAN**. Explicit zapPath is exact-input **tokenIn → fee → tokenOut**; `0x` chooses the verified executor's DEFAULT_FEE single hop. A dual exact-output reverse path is wrong here.

V3 amount0Min/amount1Min are minimum token consumption; V4 amount0Max/amount1Max are **uint128 maximum token payments**, not output minimums. Derive V3 floors and positive minLiquidity from the authorized slippage budget and simulation; derive V4 caps by rounding quoted consumption up within the authorized budget and uint128 bounds. minLiquidity protects newly minted/added liquidity in both versions. Use short explicit UNIX-second deadlines; do not substitute maximum integers or all-zero minima for quotes.

The internal swap floors use oracle fair value with a fixed **500bps** allowance; there is no separate minSwapOut/maxSwapIn argument. Open/increase expose liquidity protections, close exposes final **net LOAN** minOutSingleToken. Borrow fees are charged on open as floor(amountBorrow * BORROW_FEE_BPS / 10000), reducing funds zapped without reducing debt; current single-asset increase does not charge that fee. Unused mint/increase tokens refund to the caller in token0/token1; unlike dual, they do not automatically repay debt.

### Executable call sequences (both versions)

| Operation | READ → approval / simulation → USE → verify result |
|---|---|
| Open | Read RESERVE_ID cash/rate/credit, tokens, oracle and pool spot. Choose tick-spacing-aligned ticks straddling the current tick with width >= MIN_WIDTH_TICKS. Quote the zap using amountInvest + amountBorrow minus the open borrow fee. `LOAN.approve(VAULT,p.amountInvest)` as needed → simulate from caller → `VAULT.open(p)` using the version-specific tuple. Decode PositionOpened.id/debtId from the receipt; read positions, owner, actual current debt, value and computed health. Reconcile token dust refunds. |
| Increase | Read owner, existing range/liquidity/debt and reserve capacity; quote the LOAN→RISK zap of amountInvest + amountBorrow. `LOAN.approve(VAULT,p.amountInvest)` as needed → simulate → `VAULT.increase(id,p)`. Uses the existing debtId/range; minLiquidity covers the addition. Read PositionIncreased, remaining token dust, current debt and healthy post-state. amountBorrow=0 is collateral addition, not debt repayment. |
| Close / reduce | Save debtId and read position/current debt. Choose percent **1..10000 bps**, 10000 full (source treats >=10000 as full); require floor(liquidity * percent / 10000)>0 for partial. Quote removed principal plus collected fees net of harvest fee, RISK→LOAN swap, and repayment. No wallet approval/top-up exists. Set minOutSingleToken from protected **after-repayment LOAN proceeds** → simulate `VAULT.close(id,c)` via eth_call from holder → send the same call after fresh checks. Decode PositionClosed; re-read owner, liquidity, debt and partial-close health. |
| Harvest / claim | No approval → simulate → `VAULT.harvest(id,false,0x,deadline)`. Returns net **token0 and token1**, not consolidated LOAN; HARVEST_FEE_BPS is skimmed. Reconcile Harvested and token balances, then computed health. V3 claim does not enforce deadline; V4 passes it to fee collection. |
| Harvest / compound | No approval → quote/simulate both RISK→LOAN consolidation and LOAN→RISK re-zap → `VAULT.harvest(id,true,0x,deadline)`. Use the verified default route: the same zapPath is reused in opposite directions, so a single nonempty directional path fails endpoint checks when both swaps run. Read added liquidity, dust refunds and post-health. Returns out0/out1 remain zero in compound mode; use events/balances for refunds. |
| addMargin | **Absent in both single-asset ABIs.** Do not encode the dual call or direct wallet LendingPool repayment. Collateral-only increase is the available distinct operation, subject to successful zap and health checks. |
| rebalance | **Absent in both single-asset ABIs.** Changing range requires a separately authorized close followed by a fresh open; these are separate positions/transactions with intervening execution risk. |
| previewClose | **Absent in both single-asset ABIs.** Use a fresh spot/fee/swap estimate and simulate the actual close via eth_call from the holder; positionValue is fair collateral value, not a net payout quote. |
| Liquidate (authorized keeper only) | Verify liquidators(caller), computed unhealthy state and current debt; cap repayAmount by floor(D * CLOSE_FACTOR_BPS / 10000). `LOAN.approve(VAULT,repayAmount)` → simulate → `VAULT.liquidate(id,lp)` with RISK→LOAN path, protected minSeizeOut and deadline. Check PositionLiquidated, BadDebt, owner and saved debtId. Ordinary holders/agents have no keeper permission. |

Partial close requests ceil(currentDebt * percent / 10000), full close requests all current debt; repayment is capped by current debt and consolidated LOAN available. Close collects/skims accumulated fees before principal removal, including on partial close. The residual position must be healthy. Full close burns both receipt and underlying LP NFT; residual debt **>1000 raw LOAN units** requires a successful pre-close fair-value check proving V < D, otherwise SolventBadDebt reverts. Residual <=1000 can remain without BadDebt, so always query the saved debtId after burn. There is no single-asset addMargin route to that residual debt.

Compounding has **no caller-set minOut/minLiquidity**: V3 uses zero internal amount minimums; V4 uses uint128 maximum payment caps. Both swap directions retain the fixed oracle floor, but this does not provide a tighter user slippage limit. If policy requires tighter bounds, claim instead. Open, increase and harvest all enforce healthy post-state. Oracle errors must fail closed; do not reuse dual oracle-outage rescue guidance.

Watch PositionOpened, PositionIncreased, PositionClosed, Harvested, PositionLiquidated, BadDebt, LiquidatorSet and receipt Transfer. Single-asset vaults have no MarginAdded/Rebalanced events. Re-read state after confirmation and handle reorgs.

## Evidence and reproducibility

Signatures and behavior: local `stocklend/leverage/src/UniV3DualVault.sol`, `UniV4DualVault.sol`, `UniV3LeverageVault.sol`, `UniV4LeverageVault.sol`, `LpShareOracleV4.sol`, `SwapExecutorV3.sol`, `lending/lendingpool/LendingPool.sol`, `lending/libraries/logic/{ReserveLogic,InterestRateUtils}.sol` and `libraries/FairLpMath.sol`. ABI provenance records source/build hashes; source references here identify the sibling contract repository and are not runtime endpoints or bundled files.

Deployment example: `stocklend/leverage/deployments/sepolia-2026-09-06.md` (V3 dual id 1, mock tokens, based on a3549af; recorded smoke open/full-close, not re-run in this offline pass). Feed observation: `stocklend/leverage/docs/FINDING-rh-eth-feed-staleness-2026-09-06.md`, including its **same-day revised conclusion**. Product behavior observations are context for monitoring, not a guarantee of future prices, liquidity or keeper execution.
