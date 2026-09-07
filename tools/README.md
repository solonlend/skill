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

Offline verification from the repository root:

```sh
node --test tools/lib/farm-math.test.mjs
node --check tools/solon-farm-read.mjs
```
