# Auto LP (Range Vaults / CLM) — agent guide

> Passive tier: auto-managed Uniswap V3 concentrated liquidity at 1x. **No leverage, no
> liquidation, no oracle dependency** — the calm gate uses the pool's own 2-minute TWAP.
> Fork of Beefy's battle-tested `StrategyPassiveManagerUniswap` (MIT), with the swapper/
> router/quoter dependency removed: fees are charged and re-invested **in kind, two-sided,
> zero swaps**.
>
> **Status (2026-09-11):** full lifecycle (deposit → fee harvest → range re-center → partial
> and full withdraw, plus the NotCalm gate both blocking and releasing) verified on live
> Sepolia — see the deployment record referenced below. **Robinhood Chain mainnet is NOT
> deployed yet**; first-batch candidate pools: ETH/USDG 0.01%, NVDA/USDG 0.05%, GLD/USDG
> 0.3%, SGOV/USDG 0.3%. Addresses land in `addresses.json` under `rangeVaults` at launch —
> until that key exists, any "Solon Auto LP" address you meet elsewhere is not ours.

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
→ total managed amounts. `vault.totalSupply()`, `vault.balanceOf(you)` → your share.
`strategy.price()` (token1 per token0, 1e36-scaled), `strategy.range()` → managed band,
`strategy.lastPositionAdjustment()`, `vault.isCalm()`. Runnable reference:
`cd tools && node solon-range-read.mjs --rpc <url> --vault <addr> [--account <you>] [--json]`
— pinned-block snapshot of all of the above.

**VERIFY** (before value):
1. `vault.strategy()` and the strategy's `vault()` point at each other; `strategy.pool()`
   is the official-factory Uniswap V3 pool for the advertised pair/fee tier.
2. The vault address matches the pinned `addresses.json` (`rangeVaults` key) — never an
   address from a chat, site mirror, or search result.
3. `strategy.paused()` is false; `vault.isCalm()` readable.
4. Fee facts on-chain match this doc: deposit 0, withdrawal 0, performance fee 10% of
   harvested yield (a slice of it is the public caller's incentive), charged only at
   harvest, never from principal.

**USE — deposit** (calm-gated):
```
(shares, take0, take1, fee0, fee1) = vault.previewDeposit(amount0, amount1)
token0.approve(vault, take0); token1.approve(vault, take1)
vault.deposit(take0, take1, minShares)        // minShares: e.g. 99% of previewed shares
```
- `take*` may be below your inputs (one-sided or off-ratio input: the vault takes only what
  the current position mix can absorb). `fee*` > 0 flags the balancing fee on an
  imbalanced fill — expected, not an error.
- Reverts `NotCalm` while spot is off the pool's 2-min TWAP beyond the deviation bound.
  Re-read `isCalm()` and retry; the gate exists to block price-manipulation entries.

**USE — withdraw** (never calm-gated):
```
(out0, out1) = vault.previewWithdraw(shares)
vault.withdraw(shares, minOut0, minOut1)      // e.g. 99% of previewed outs
```
- One edge: a withdraw in the **same second** as any deposit into the strategy re-checks
  calm (strategy-level `lastDeposit`, not per-account). Wait one block and it clears.
- You always receive both tokens at the current in-vault mix — full-range exit, no swap.

**USE — harvest** (optional, public, calm-gated): anyone may call `strategy.harvest()`
(or `harvest(recipient)`); the caller's slice of the performance fee pays for gas. Yield
accrues to holders as share price: `totalSupply` is unchanged by harvest while `balances()`
grow — there is no reward token and nothing to claim.

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

## Cross-references
- Contract source: open-sourced at launch; lifecycle drill record
  `deployments/sepolia-clm-*.md` in the main repo (tx-level, including a real NotCalm
  block-and-release and a public harvest with caller fee).
- Reader tool schema and caveats: `tools/README.md`.
