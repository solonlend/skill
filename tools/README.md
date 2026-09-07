# Solon farm reference reader

A byte-diffable reference reader implementing [FARM-GUIDE](../FARM-GUIDE.md)'s position, health and PnL read layer. An agent runs it locally; there is no server. Supports `dual-v3`, `dual-v4`, `single-v3`, `single-v4`, with positive getter probes when `--kind` is omitted.

**Read-only / no keys:** only public JSON-RPC reads and `eth_call` of ABI-declared view/pure functions. No wallet client, signing, approvals or transaction submission. No private-key argument, environment lookup, key file loading or stdin. `--entry` accepts inline JSON only. RPC URLs are never included in output.

Node 22+; install from this directory on a network-enabled machine:

```sh
cd tools
npm i
npm test
```

The dependency is pinned to viem **2.56.3**, also present in the local leverage keeper lockfile. Installation and live RPC execution were not performed in the build sandbox.

```sh
node solon-farm-read.mjs \
  --rpc https://ethereum-sepolia-rpc.publicnode.com \
  --vault 0x76C3F4730098dfAc400125E7ae16636C566B8009 \
  --id 1 --kind dual-v3 --json > position.json
```

Replace `1` with an actual receipt ID; it is not an LP NFT or debt ID. This is the **test-only, mock-backed Sepolia** instance from `addresses.json.leveragedFarms.sepoliaExample`, chain **11155111**. Its deployment revision/configuration is not certified by this reader. V4 and single-asset addresses are TBD: no example address or chain fallback is invented. Other addresses must be explicitly supplied and independently verified.

Use `--block N` with an archive-capable RPC to reproduce a historical snapshot. Otherwise latest is resolved once. Every call uses that block number; the block hash is checked again before output (a detected reorg rejects the snapshot). This assumes an honest, consistent RPC. The human summary goes to stderr with `--json`, leaving stdout as standalone JSON. Exit codes: `0` snapshot produced, `1` arguments/transport/shape failure, `2` structured but **UNRELIABLE** health. A search failure is explicitly `SEARCH_FAILED`, never a claimed absent root.

Every numeric JSON leaf is `{value: "decimal integer", blockNumber, blockHash, source}`. `value` is a string, never a floating-point quantity. Derived values inherit the pinned block and include the two feeds' round IDs, update times and ages. `reads` contains source addresses, exact getters, arguments and results, sorted deterministically. Raw contract results remain evidence when health is unreliable; do not consume them as validated health.

**Math conventions:** token/debt/equity amounts are raw token units; `LLTV` is WAD. Capacity is `floor(V*LLTV/1e18)` and headroom is signed `capacity-D`. `healthBps` floors `D*1e18*10000/(V*LLTV)` without prematurely flooring the denominator; lower is safer, 10000 bps is 100%. Equality is healthy according to the contract. Infinite and inactive cases are explicitly distinguished; an absent/burned owner is never presented as an active healthy position. Single-asset debt comes from `LendingPool.getCurrentDebt(debtId)`; its vault has no health/debt/preview-close getters. Neither dual vault has `health()` either.

Tick prices are LOAN per RISK, returned as `{mantissa, scale}` with scale `10^36`, using source TickMath rounding. This is a display approximation to `1.0001^tick * 10^(dec0-dec1)` (inverted for RISK=TOKEN1); LP valuation uses exact Q96 sqrt math, not that display value. LiquidityAmounts' double floor and FairLpMath's per-token USD-feed floors precede USD-to-LOAN conversion. Feed answers must share decimals, matching LpShareOracleV4's constructor.

Liquidation estimates freeze liquidity, range, current interest-inclusive debt quantities and the LOAN/USD feed answer; the integer RISK/USD feed answer varies. This resolves the guide's unspecified candidate-price precision and USD numeraire. Adjacent healthy/unhealthy feed-answer brackets expose boundary rounding; equality need not exist on the integer lattice. `null` means no transition on that searched side within the supported oracle domain, not immunity to interest or future LP changes. Single-asset uses only LOAN debt and one boundary. Feed invalidity/staleness/depeg or a reference/contract valuation mismatch suppresses trusted health and boundaries; pool spot is diagnostic only. The supported oracle model is **LpShareOracleV4** with verified feed/decimal wiring, including when used by a V3 or single-asset vault; older/different oracles fail closed.

Pure boundary API (also used directly by the CLI):

```js
dualLiquidationBoundaries({
  liquidity, tickLower, tickUpper, dRisk, dLoan, lltv,
  dec0, dec1, riskIsToken0,
  currentRiskPrice, // required positive native RISK/USD feed answer
  loanPrice,        // required positive native LOAN/USD answer, same feed decimals
  // Optional minRiskPrice/maxRiskPrice narrow the native-answer search domain.
  // Optional maxEvaluations defaults to 100000n; exhaustion throws SEARCH_LIMIT.
});
```

All quantities are BigInt; `riskIsToken0` is boolean. `singleLiquidationBoundary` takes the same arguments with `dRisk` absent/zero and returns one candidate: downward first, otherwise upward for an unhealthy starting price. Rounding can create tiny extra transitions, so this does not assert continuous-price uniqueness. Candidate `price` is the unhealthy side's `10^36` display value; `bracket.lower`/`bracket.upper` carry adjacent native feed answers and exact valuation/capacity/debt. `fairPositionAtRiskPrice` takes `riskPrice` instead of `currentRiskPrice` to evaluate one candidate. For debt-growth scenarios, callers can supply increased current-debt amounts and rerun; CLI output freezes debt at the reported block.

Oracle target-config differences are warnings in this read-only tool; freshness/depeg verdicts use the actual pinned getters. Such warnings do not authorize opening/increasing leverage with a configuration different from the intended target.

Optional PnL uses this explicit caller-supplied schema (all integer fields are strings):

```sh
node solon-farm-read.mjs \
  --rpc https://ethereum-sepolia-rpc.publicnode.com \
  --vault 0x76C3F4730098dfAc400125E7ae16636C566B8009 --id 1 --json \
  --entry '{"chainId":"11155111","vault":"0x76C3F4730098dfAc400125E7ae16636C566B8009","positionId":"1","blockNumber":"1","netEquityLoan":"1000000000","netDepositsLoan":"0","withdrawalsLoan":"0"}'
```

Replace the illustrative entry block and equity with your saved entry observation. `netDepositsLoan` is additional contributed value since entry (including margin); `withdrawalsLoan` includes distributions since entry. Both default to zero; value risk-token cash flows in LOAN at their own execution times. PnL = current net equity + withdrawals − entry net equity − deposits. Entry data is tagged as user-supplied, not read from the chain. This is equity-change PnL, excluding uncollected fees, exit costs/slippage and gas; there is no inferred trade history or return/APY claim.

**This is an estimate/reference. Always cross-check live contract state; a simulation is not a mined result.** No runtime/source match or audit certification is implied. Retained debt IDs after a receipt burn can represent bad debt; inspect `BadDebt` events separately. FARM-GUIDE's access policy applies.

## Pre-broadcast simulation (`solon-farm-sim.mjs`)

Static-preview a dual-borrow farm operation **before** broadcasting. It runs the exact
vault call as an `eth_call` from a given address (no wallet, no signing, no transaction,
no key) at a pinned block and reports two things:

1. **Pre-flight verdict** — `WILL_SUCCEED` (with any return value, e.g. `open`'s NFT id),
   or `WILL_REVERT` with the decoded vault error. The vault's 22 custom errors decode by
   name (`UnhealthyOpen`, `UnhealthyIncrease`, `SlippageLiq`, `RangeTooNarrow`, `NotHolder`,
   `SolventBadDebt`, …), with a plain-language hint; standard `Error(string)`/`Panic` and the
   lending pool's numeric codes pass through as-is. A successful pre-flight proves the
   on-chain post-action health check passed.
2. **Projected health (open/increase, estimate)** — reusing `farm-math`, it projects the
   resulting `V`/`D`/utilization/headroom and added liquidity from the intended amounts at
   current spot. This is an **estimate**: it assumes the full invest+borrow deploys with no
   same-leg surplus repay, so real net debt ≤ projected. The pre-flight, not this number, is
   the health guarantee.

```sh
node solon-farm-sim.mjs \
  --rpc https://ethereum-sepolia-rpc.publicnode.com \
  --vault 0x76C3F4730098dfAc400125E7ae16636C566B8009 \
  --from  <the caller/owner address> \
  --op increase --id 4 \
  --params '{"investRisk":"0","investLoan":"0","borrowRisk":"1000000000000000","borrowLoan":"2000000","amount0Min":"0","amount1Min":"0","minLiquidity":"0","deadline":"9999999999"}'
```

`--params` is **inline JSON only** (never a file path); all integer fields must be **strings**
(an unquoted JSON bigint loses precision at parse time and is rejected). `--id` is required for
every op except `open`. The human summary goes to stderr; `--json` additionally writes the
structured object to stdout. Exit codes: `3` = `WILL_REVERT`, `4` = `SIMULATION_ERROR` (a
transport / unavailable-historical-state / encoding failure — deliberately NOT reported as a
revert), `1` = bad arguments. The `--params` schema per op matches the vault ABI tuple
field-for-field. Swap-leg slippage quoting is intentionally omitted where no on-chain quoter is
available; do not infer a swap quote from this tool. RPC URLs are stripped from all output
(including errors), so an endpoint carrying an API key is never printed.

**Scope (v1): `--kind dual-v3` only.** The V4-dual and single-asset vaults use different
param tuples (V4 uses `amount*Max`; single uses `amountInvest`/`amountBorrow`/`zapPath`), so this
tool rejects those kinds rather than silently mis-encoding a call for them; inspect those shapes
with `solon-farm-read.mjs`, and note their post-action health is still enforced on-chain. The
projected health number is fail-closed: it is withheld (shown as *unavailable*) when either feed
is stale/invalid, the feed decimals differ, or USDG is outside its de-peg band.

Offline verification from the repository root:

```sh
node --test tools/lib/farm-math.test.mjs
node --test tools/lib/farm-project.test.mjs
node --check tools/solon-farm-read.mjs
node --check tools/solon-farm-sim.mjs
```
