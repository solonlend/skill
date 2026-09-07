---
name: solon-lending
description: Borrow USDG against tokenized US stocks (AAPL, NVDA, TSLA…) on Robinhood Chain, and earn on USDG deposits — by calling immutable Morpho contracts directly, no frontend or account. Load when an autonomous agent needs to open/manage a collateralized loan or deposit for yield on Robinhood Chain (chainId 4663).
homepage: https://solonlend.xyz
license: GPL-2.0
version: 0.2.0
pin: "Install by pinning a commit hash. This repo is the machine interface; the website is only a pointer to it."
---

# Solon — the bank an AI agent runs by itself

Solon is a curator on Morpho on Robinhood Chain: borrow **USDG** against tokenized **US stocks** as collateral; or deposit USDG to earn borrower interest. There is no API of ours in the loop — an agent brings its own wallet and calls audited, immutable, on-chain contracts. This repo IS the interface.

**Trust model:** trust the pinned commit + on-chain verification, never a live endpoint. Every address in `addresses.json` must be re-verified on-chain (`VERIFY.md`) before you send value. Solon cannot change the contracts under you (Morpho core & IRM are immutable); the trust surface is the vault curator and the market config — verify them.

For **leveraged LP farming** (LOAN-only single-asset V3/V4 with zap, and WETH + USDG Dual-Borrow V3/V4, separate from the USDG-only Morpho lending scope below), load `AGENT-GUIDE.md §10` → `FARM-GUIDE.md` for farm-specific READ → VERIFY → USE, risk rules and chain-scoped addresses. Live on Robinhood Chain since 2026-09-07: V3 dual-borrow + V3 single-borrow vaults (scaled soft launch); V4 vaults not deployed. Re-verify every address on-chain before value.

## When to use
- An agent needs to draw USDG liquidity against a tokenized-stock position **without selling the stock**.
- An agent manages a leveraged/collateralized position and must monitor health + auto-repay.
- An agent wants to deposit idle USDG for yield.

## When NOT to use
- You are (or act for) a person/entity in the **US, China, or a sanctioned jurisdiction** — not offered to you; using a VPN/proxy/direct call to bypass is a knowing violation.
- You want to **short/borrow the stock itself** — not supported in v1 (loan asset is USDG only).
- You need a chain other than Robinhood Chain (4663).
- You expect a hosted service, push notifications, or custody — there is none; you run everything.

## Strategy (READ → VERIFY → USE)
1. **READ** — load `addresses.json` + the ABIs in `abis/`. Resolve the market: `marketParams = {loanToken:USDG, collateralToken:<stock>, oracle, irm, lltv}`; `id = keccak256(abi.encode(marketParams))`. Read `core.market(id)`, `core.position(id, you)`, `oracle.price()`.
2. **VERIFY** — run the checklist in `VERIFY.md`: core is the immutable official Morpho, IRM is enabled and canonical, oracle came from the official factory, and (for deposits) the vault's owner/curator/queues/caps are sane. Do this **before** the first value-moving tx.
3. **USE** — the exact call sequences and health/APR math are in `AGENT-GUIDE.md`. Borrow = `approve` → `supplyCollateral` → `borrow`. Close = `repay` → `withdrawCollateral`. Deposit for yield = ERC-4626 `deposit` on the Solon vault.

## Runnable reference tools (`tools/`)

The guides' read layer also exists as **runnable, byte-diffable reference code** (`cd tools && npm i`,
Node 22+, viem pinned). All three are read-only — no keys, no transactions, RPC URLs stripped
from output — and pin every figure to a block with feed/round provenance:

- `solon-market.mjs` — a lending market's live params, borrow/supply APY, tier, and the
  `VERIFY.md` checks run on-chain automatically with the actual values.
- `solon-farm-read.mjs` — a leveraged-farm position's health, both liquidation boundaries,
  net equity and PnL (all four vault shapes).
- `solon-farm-sim.mjs` — static pre-flight of a farm op via `eth_call` before broadcasting:
  WILL_SUCCEED / WILL_REVERT with the decoded vault error, plus projected post-op health
  (dual-v3 in v1).

They implement the math in these guides — diff them against the prose; `tools/README.md` has
usage, schemas and caveats. They are estimates/references, not a hosted service: verify on-chain
yourself before sending value.

## Market certification tiers

Market creation on Morpho is permissionless — you can create your own market and lend into it
(see AGENT-GUIDE.md "Creating your own market"). Solon classifies markets in three tiers:

1. **SOLON CERTIFIED** — created by Solon: our fail-closed oracle adapter, conservative LLTV,
   listed in `addresses.json` under `solon.markets`. Safest defaults; these earn points when
   vault-funded.
2. **ISSUER-VERIFIED** — third-party markets whose collateral passed our on-chain issuer check
   (EIP-1967 beacon slot == Robinhood's token beacon `0xe10b6f6b275de231345c20d14ab812db62151b00`;
   a counterfeit ticker cannot forge this slot). Parameters are the creator's — judge them yourself.
3. **UNCERTIFIED** — everything else, including markets you create. Fully permitted, fully your
   risk; Solon does not list, monitor, or backstop them.

Verify the tier yourself: run the beacon check on the collateral, and compare the market's oracle
against `solon.oracleAdapters` for tier 1.

## Gotchas
- **Amounts:** pass `assets=X, shares=0` for an exact token amount; pass `assets=0, shares=myShares` to close a position with **no dust**. Exactly one must be zero.
- **Oracle scale:** `price()` is scaled `1e(36 + loanDec − collDec)` = `1e24` for USDG/stock. It returns collateral priced in the loan token.
- **Stale totals:** `market()` totals lag until `accrueInterest`; simulate accrual with the IRM (`AGENT-GUIDE.md §2`) for exact live figures.
- **Weekends:** US market closed → stock feed freezes → conservative LLTV + staleness bound + a keeper on market hours. Expect it; don't assume a fresh price on a Saturday.
- **Vault ≠ v1.1:** Robinhood Chain uses Morpho **Vault V2**, not classic MetaMorpho — different roles/interface.
- **Logs:** the public RPC caps `eth_getLogs` by result size (RH ≈130 logs/block); filter by topic+address and page in bounded windows, or use the Morpho GraphQL API (`https://api.morpho.org/graphql`).

## What success looks like
A fresh agent, given only this repo + a funded dedicated wallet, can: resolve a market, verify it on-chain, `supplyCollateral` + `borrow` USDG, compute its own health factor and liquidation price, subscribe to core events, and auto-repay before health crosses 1 — with no human and no server of ours involved.

## Safety rules (non-negotiable)
- Dedicated wallet, this session's funds only. Never put a private key in a prompt/config.
- Manage your **own** health from core events; there is no hosted push.
- Verify market/vault config before the first tx, not after.

## See also
- `AGENT-GUIDE.md` — the full per-module read/verify/use reference + a live worked example.
- `VERIFY.md` — the "is this really official Morpho?" checklist.
- `addresses.json` — pinned Robinhood Chain addresses (verify on-chain).
- `adapter/StockOracleAdapter.sol` — Solon's only self-written on-chain code (open, byte-diffable).
- `tools/` — runnable read-only reference CLIs: market info + automated VERIFY, farm position/health reader, pre-broadcast simulator.
- Morpho docs: https://docs.morpho.org · SDKs: `@morpho-org/*` on npm.
