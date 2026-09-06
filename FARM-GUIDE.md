# Solon — Leveraged LP Farm Integration Guide

Extension of **AGENT-GUIDE §10**, in the same **READ → VERIFY → USE** order. This is the Dual-Borrow farm interface; §§0–9, Morpho certification, the USDG-only lending restriction and the historical “only StockOracleAdapter is new code” statements describe the **lending side**. They do not describe these additional Solon contracts. Do not apply Morpho ABIs, market ids, approvals or audit/immutability claims to a farm.

> **Access policy.** Solon is not offered to persons/entities in the United States, China, or sanctioned jurisdictions; this applies equally to direct calls and autonomous agents. Do not bypass restrictions. **Leveraged LP positions can be liquidated and lose funds.** Use a dedicated wallet, keep keys outside prompts/config strings, and monitor your own positions; there is no hosted push service.

## Product and contracts

**Dual-Borrow leveraged LP:** invest and borrow each asset separately — WETH (RISK) + USDG (LOAN) — in the proportions required by a Uniswap V3/V4 concentrated-liquidity range. LP fees are revenue; interest on **both** reserves and protocol fees are costs. This differs from the stock-collateral loan in the lending guide.

Open and increase perform **zero swaps**. Close returns LP assets and repays each matching debt leg, with zero swaps **when both legs cover repayment, including any wallet top-ups**. A deficit can invoke a swap; “zero-swap open/close” is not an unconditional close guarantee. Use `maxSwapIn=0` and enough top-ups for a no-swap close, then simulate.

| Contract | Responsibility |
|---|---|
| `UniV3DualVault` | First-launch target: holds V3 LP NFTs, records two debt ids per receipt and manages open/close, margin, range, fees and permissioned liquidation. |
| `UniV4DualVault` | Equivalent dual-debt lifecycle on V4 PositionManager/StateView, with different mint/increase tuples; select its own ABI. |
| `UniV3LeverageVault` / `UniV4LeverageVault` | Single-asset versions invest/borrow LOAN and zap into LP; these have one debt id and different signatures, outside the executable sequences below. |
| `LendingPool` | Separate farm lending engine with WETH and USDG reserves, per-reserve interest/credit controls and debt accounting; not Morpho Blue. |
| `LpShareOracleV4` | Values LP and risk debt from external feeds with separate risk/stable staleness bounds and a USDG depeg band; also used by the V3 dual vault. |
| `SwapExecutorV3` | Adapts vault gap/delta swaps to V3 SwapRouter02 exact-input/exact-output routes and refunds unused input. |

## READ — resolve the position, debt and price

Load `addresses.json.leveragedFarms` and `abis/FARM-ABI-SOURCES.json`; pick the chain and exact vault shape. **Mainnet farm addresses are `<TBD>`: stop before approvals or transfers.** Sepolia is an explicitly selected test-only example, chainId **11155111**, using mocks; never fall back to it from 4663. The top-level address-book `verifiedAt` covers the pre-existing lending snapshot, not the new farm records.

The shipped ABIs include complete dual-vault interfaces, LendingPool, oracle and executor plus minimal compiled pool/feed interfaces. All amounts are raw token units; read `decimals()` (WETH normally 18, USDG normally 6), never assume TOKEN0 is RISK. Read `TOKEN0`, `TOKEN1`, `LOAN_IS_C0`, `RISK`, `LOAN`, `RESERVE_RISK`, `RESERVE_LOAN`, `ORACLE`, `LENDING_POOL`, `SWAP_EXECUTOR`, `LLTV`, `MIN_WIDTH_TICKS` and fee getters.

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

`positionValue` is gross LP fair value in LOAN base units (not equity, not a spot quote, and excluding uncollected trading fees). `totalDebtInLoan` = oracle-valued current risk debt + current loan debt. `previewClose` uses **pool spot** and LP principal, not uncollected fees; its per-leg dues include current interest and round up for a partial close. It is an estimate of shortages, not a guaranteed quote or a health oracle.

### Health and two liquidation boundaries

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

### Oracle timeliness and USDG depeg

Read `FEED0`, `FEED1`, `LOAN_FEED`, `RISK_FEED`, `DEC0`, `DEC1`, `LOAN_DEC`, `RISK_DEC`, `RISK_MAX_STALENESS`, `STABLE_MAX_STALENESS`, `STABLE_DEPEG_BPS`. On each underlying feed read `decimals()` and `latestRoundData()` (roundId, answer, startedAt, updatedAt, answeredInRound). The oracle checks:

- Nonzero roundId/updatedAt, answeredInRound >= roundId, positive answer; future timestamps also fail arithmetic.
- `block.timestamp - updatedAt <= RISK_MAX_STALENESS` for the risk leg, and `<= STABLE_MAX_STALENESS` for LOAN_FEED.
- USDG/USD within `1 USD * (1 ± STABLE_DEPEG_BPS/10000)`, inclusive, in feed decimals; outside either bound reverts `StablecoinDepegged`.

Current source constructor bounds are risk **1–48 hours**, stable **25–48 hours**, depeg **10–500 bps**; these are allowed bounds, not live settings. RH ETH/USD is deviation-triggered with a long heartbeat: the project's 2026-09-06 sample observed a **24.01h maximum gap**, with more frequent updates during volatility and deviations around 0.5%. That is historical observation, not a guaranteed maximum or update SLA. The finding's revised risk-staleness example is **26h**; the Sepolia deployment record still says **10800s risk / 93600s stable / 100bps**, and mentions 50bps as a mainnet intention. Read each actual deployment; do not propagate the old 3h risk setting or a planned mainnet value as fact.

Fail closed when price reads fail: do not cache the last good health as current, substitute pool spot, or assume a quiet feed is necessarily working. A long staleness allowance also delays detection of a feed outage. Pause new/increased leverage and alert locally. `addMargin` repays tokens without reading the oracle, so it can still reduce debt. A fully funded full close with **zero** remaining risk shortage can avoid failed oracle reads; a nonzero risk shortage invokes the oracle even before top-up/dust handling, and partial close checks health. Simulate the exact path; oracle failure is not permission to discard debt or disable guards.

## VERIFY — before the first value-moving transaction

Keep the pinned-commit and on-chain re-verification discipline of `VERIFY.md`; its Morpho-specific factory/owner checks do not certify farms.

1. Check `eth_chainId`, reject `<TBD>`, zero addresses and cross-chain records; fetch non-empty runtime bytecode for every vault/dependency/token/feed. The Sepolia example is transcribed from `stocklend/leverage/deployments/sepolia-2026-09-06.md`, not freshly verified here. This pass is offline.
2. Match deployed code to pinned deployment source/build, accounting for compiler settings, linked libraries, metadata and immutable constructor values; detect any proxy and verify its implementation/admin. Local current-source ABI provenance is in `abis/FARM-ABI-SOURCES.json`. A local artifact match does not prove the dated Sepolia deployment runs the same revision: the record says “based on a3549af”; verify before use.
3. Verify vault `GOVERNOR`, `POSITION_MANAGER`, `POOL` (V3), token ordering, `FEE`, reserves, oracle and executor wiring. Check the pool's actual tokens/fee/tick spacing and PositionManager/factory relationship; both reserves' underlying tokens must match RISK/LOAN. For V4 verify `POOL_ID`, `STATE_VIEW`, `TICK_SPACING`, `HOOKS` and the pool key against its manager; do not use V3 `slot0` on a V4 manager.
4. Read LLTV, minimum width, close factor, liquidation bonus, protocol and harvest fees. Inspect LendingPool owner/addressRegistry, pause state, reserve flags/rate config, borrowing whitelist and both credits. These are additional trust surfaces; do not inherit the lending core's limited-governance claims.
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

### V4 and single-asset routing

The above parameter tuples are for **V3 dual only**. `abis/uni-v4-dual-vault.json` has `OpenParams` with **uint128 amount0Max, uint128 amount1Max**, not V3 amount0Min/amount1Min; its `IncreaseParams` omits both amount minimum fields and uses minLiquidity. Re-derive caps from that implementation; do not encode V3 tuples at V4 addresses. The single-asset vaults have `amountInvest/amountBorrow`, one debt id, zap fields and different close/harvest interfaces; they are described only for identification here, and are not a fallback for dual operations.

Watch vault `PositionOpened`, `PositionIncreased`, `PositionClosed`, `MarginAdded`, `Rebalanced`, `Harvested`, `PositionLiquidated`, `BadDebt`, `LiquidatorSet` and receipt `Transfer` events; re-read on-chain state after confirmation and handle reorgs. Use bounded topic/address-filtered log windows as in the lending guide.

## Evidence and reproducibility

Signatures and behavior: local `stocklend/leverage/src/UniV3DualVault.sol`, `UniV4DualVault.sol`, `LpShareOracleV4.sol`, `SwapExecutorV3.sol`, `lending/lendingpool/LendingPool.sol`, `lending/libraries/logic/{ReserveLogic,InterestRateUtils}.sol` and `libraries/FairLpMath.sol`. ABI provenance records source/build hashes; source references here identify the sibling contract repository and are not runtime endpoints or bundled files.

Deployment example: `stocklend/leverage/deployments/sepolia-2026-09-06.md` (V3 dual id 1, mock tokens, based on a3549af; recorded smoke open/full-close, not re-run in this offline pass). Feed observation: `stocklend/leverage/docs/FINDING-rh-eth-feed-staleness-2026-09-06.md`, including its **same-day revised conclusion**. Product behavior observations are context for monitoring, not a guarantee of future prices, liquidity or keeper execution.
