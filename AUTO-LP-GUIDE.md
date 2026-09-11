# Auto LP (Range Vaults / CLM) — agent guide

> Passive tier: auto-managed Uniswap V3 concentrated liquidity at 1x. **No leverage, no
> liquidation, no external price oracle** — the calm gate relies on the pool's own TWAP
> (interval and deviation bound are owner-tunable strategy parameters; read them, below).
> Fork of Beefy's battle-tested `StrategyPassiveManagerUniswap` (MIT), with the swapper/
> router/quoter dependency removed: fees are charged and re-invested **in kind, two-sided,
> zero swaps**.
>
> **Status (2026-09-11):** full lifecycle (deposit → fee harvest → range re-center → partial
> and full withdraw, plus the NotCalm gate both blocking and releasing) verified on live
> Sepolia — see the deployment record referenced below. **Robinhood Chain mainnet is NOT
> deployed yet**; first-batch candidate pools: ETH/USDG 0.01%, NVDA/USDG 0.05%, GLD/USDG
> 0.3%, SGOV/USDG 0.3%. `addresses.json → rangeVaults.robinhoodMainnet.vaults` is an
> **empty list until launch** — while it is empty, any "Solon Auto LP" mainnet address you
> meet elsewhere is not ours. The Sepolia drill instance is pinned in
> `rangeVaults.sepoliaRehearsal` (mock tokens, value-free).

Access policy: identical to `AGENT-GUIDE.md` — not offered to persons/entities in the US,
China, or sanctioned jurisdictions; circumvention is a knowing violation by the accessing
party, human or agent.

## When to use
- An agent holds both legs of a supported pair and wants LP fee yield without managing
  ticks, compounding, or liquidation risk.
- An agent wants a position it can exit **in any market condition** (withdrawals are never
  calm-gated; see the one same-second edge below).

## When NOT to use
- You hold only one leg and expect the vault to swap for you — it never swaps. Imbalanced
  deposits are accepted (the vault takes what it can use and charges a balancing fee on the
  one-sided fill), but ratio conversion is your job.
- You need a fixed token mix back: the in-vault mix drifts with price and is never
  force-rebalanced by selling. Out-of-range periods earn no fees and lean toward one token.
- You want leverage — that is `FARM-GUIDE.md`, a different product with liquidation risk.

## Contracts (two per vault)
| Contract | Role |
|---|---|
| `SolonRangeVault` | Share accounting + user entry/exit: `deposit`, `withdraw`, previews, `balances()`, `totalSupply()`, `isCalm()` |
| `RangeStrategyUniV3` | Position manager: main (two-sided) + alt (one-sided) V3 ranges, public `harvest()`, rebalancer-gated `moveTicks()` |

## READ → VERIFY → USE

**READ.** `vault.wants()` → the two tokens (order = pool token0/token1). `vault.balances()`
→ total managed amounts, **minus** still-locked harvest profit and pending fees (see
harvest, below). `vault.totalSupply()`, `vault.balanceOf(you)` → your share.
`strategy.price()` → token1 raw units per token0 raw unit, 1e36-scaled: the human price is
`price / 1e36 * 10^(decimals0 - decimals1)` — skipping the decimals term misreads any pair
whose decimals differ. `strategy.range()` returns the managed band in the same scaling.
`strategy.lastPositionAdjustment()`, `vault.isCalm()`, `strategy.twapInterval()` and
`strategy.maxTickDeviation()` (both owner-settable; interval floor 60s). Runnable reference:
`cd tools && node solon-range-read.mjs --rpc <url> --vault <addr> [--account <you>] [--json]`
— pinned-block snapshot of all of the above.

**VERIFY** (before value — every step below is an executable on-chain read):
1. `vault.strategy()` and `strategy.vault()` point at each other; `strategy.pool()` is the
   official-factory Uniswap V3 pool for the advertised pair/fee tier — confirm with
   `IUniswapV3Factory(pool.factory()).getPool(token0, token1, fee) == pool` against the
   canonical Uniswap deployment for that chain.
2. The vault address matches this repo at your pinned commit: mainnet vaults live in
   `addresses.json → rangeVaults.robinhoodMainnet` (empty until launch — an empty list
   means **no mainnet Auto LP address is ours**); the Sepolia drill instance lives in
   `rangeVaults.sepoliaRehearsal`. Never accept an address from a chat, site mirror, or
   search result.
3. `strategy.paused()` is false; `vault.isCalm()` readable; read the calm parameters
   `strategy.twapInterval()` / `strategy.maxTickDeviation()`.
4. Fees, read on-chain: `strategy.factory()` → `factory.getFees()` returns
   `(total, call)`, both 18-decimals fractions of harvested yield — launch values
   `0.1e18` (10%) total with `0.05e18` caller slice carved out of it, never added on top.
   No fixed deposit or withdrawal fee exists. The fee applies to harvested yield only,
   never principal; harvested net profit unlocks into `balances()` linearly over 1 hour
   (`lockedProfit`).

**USE — deposit** (calm-gated):
```
(shares, take0, take1, fee0, fee1) = vault.previewDeposit(amount0, amount1)
token0.approve(vault, take0); token1.approve(vault, take1)
vault.deposit(take0, take1, minShares)        // minShares: e.g. 99% of previewed shares
```
- **Preview first, then decide what to bring**: depending on the vault's current mix,
  `previewDeposit` may take **zero of one leg** (and zero shares for a deposit it cannot
  use). The preview is also not a binding quote — pool state moves between preview and
  execution; the `minShares` buffer is what absorbs that drift.
- `take*` may be below your inputs (one-sided or off-ratio input: the vault takes only what
  the current position mix can absorb). `fee*` > 0 is the balancing fee — it depends on the
  **vault's own imbalance and how much your deposit fills the short side**, not simply on
  whether your inputs look symmetric: a both-sided deposit can still incur it, a first
  deposit into an empty vault never does. Expected, not an error. A badly one-sided input
  can end with zero shares (`NoShares` revert) — re-preview rather than force it.
- `minShares` is **your** tolerance choice, not a contract guarantee; 99% of the previewed
  value is a sane default. Compute it in raw integer units (tiny amounts can floor to 0).
- Reverts `NotCalm` while spot is beyond the deviation bound from the pool TWAP. Do not
  blind-resend: wait, re-read `isCalm()`, **re-run previewDeposit and re-simulate with the
  exact parameters you will send**, then broadcast. Never loosen `minShares` in response
  to a failure. The gate exists to block price-manipulation entries.

**USE — withdraw** (never calm-gated):
```
(out0, out1) = vault.previewWithdraw(shares)
vault.withdraw(shares, minOut0, minOut1)      // e.g. 99% of previewed outs
```
- `minOut0`/`minOut1` bound each token independently (raw integer units), not total value;
  99% of each previewed amount is a sane default. Never loosen them after a failure.
- Edges to know: a withdraw sharing a **second** with any deposit into the strategy
  re-checks calm (strategy-level `lastDeposit`, not per-account — a stream of deposits can
  keep re-triggering it); and the exit path still *reads* `isCalm()` (a false result only
  skips re-adding liquidity, but if the pool's `observe()` itself reverts, the read
  reverts). In practice exits clear promptly; "never calm-gated" means volatility alone
  cannot lock you in, not that no revert path exists.
- You receive both tokens at the current in-vault mix — no swap; at a range edge one of
  the two amounts can legitimately be zero.

**USE — harvest** (optional, public, calm-gated): anyone may call `strategy.harvest()`
(caller reward goes to **`tx.origin`** — relevant if you execute through a smart account)
or `harvest(recipient)`. The reward is the caller slice of the performance fee, paid
in-kind in token0/token1 — it is **not** guaranteed to exist or to cover your gas;
estimate pending fees before calling. Yield accrues to holders as share value:
`totalSupply` is unchanged by harvest, and the net profit **unlocks into `balances()`
linearly over 1 hour** — an exit immediately after harvest does not capture the still-
locked remainder. There is no reward token and nothing to claim.

## Risk facts (state them, do not soften them)
- **Drift:** the token mix follows the market; no loss is forced, but you exit at the
  then-current mix, not your deposited mix.
- **Out-of-range:** no fees accrue and the position is one-sided until the keeper
  re-centers (`moveTicks` — rebalancer-whitelisted and calm-gated; timing is keeper
  policy, not a contract economic trigger).
- **Stock/ETF pools** (NVDA, GLD, SGOV): the equity leg gaps over weekends/market close
  while the pool trades on; expect wider drift and re-center after gaps.
- Contracts are pre-audit at first launch (scaled soft launch, same posture as the farm
  tier). Size accordingly.

## Minimal ABI (the exact fragments this guide uses)
```json
[
 {"type":"function","name":"strategy","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
 {"type":"function","name":"wants","stateMutability":"view","inputs":[],"outputs":[{"type":"address"},{"type":"address"}]},
 {"type":"function","name":"balances","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"},{"type":"uint256"}]},
 {"type":"function","name":"totalSupply","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
 {"type":"function","name":"balanceOf","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]},
 {"type":"function","name":"isCalm","stateMutability":"view","inputs":[],"outputs":[{"type":"bool"}]},
 {"type":"function","name":"previewDeposit","stateMutability":"view","inputs":[{"type":"uint256"},{"type":"uint256"}],"outputs":[{"type":"uint256"},{"type":"uint256"},{"type":"uint256"},{"type":"uint256"},{"type":"uint256"}]},
 {"type":"function","name":"deposit","stateMutability":"nonpayable","inputs":[{"type":"uint256"},{"type":"uint256"},{"type":"uint256"}],"outputs":[]},
 {"type":"function","name":"previewWithdraw","stateMutability":"view","inputs":[{"type":"uint256"}],"outputs":[{"type":"uint256"},{"type":"uint256"}]},
 {"type":"function","name":"withdraw","stateMutability":"nonpayable","inputs":[{"type":"uint256"},{"type":"uint256"},{"type":"uint256"}],"outputs":[]}
]
```
Strategy: `vault()->(address)`, `pool()->(address)`, `factory()->(address)`,
`price()->(uint256)`, `range()->(uint256,uint256)`, `positionMain()->(int24,int24)`,
`lastPositionAdjustment()->(uint256)`, `paused()->(bool)`, `twapInterval()->(uint32)`,
`maxTickDeviation()->(int56)`, `harvest()`, `harvest(address)`. Factory:
`getFees()->(uint256,uint256)`.

## Cross-references
- Contract source: open-sourced at launch; lifecycle drill record
  `deployments/sepolia-clm-*.md` in the main repo (tx-level, including a real NotCalm
  block-and-release and a public harvest with caller fee).
- Reader tool schema and caveats: `tools/README.md`.
