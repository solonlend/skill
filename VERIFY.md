# VERIFY — is this really the official, unmodified Morpho?

Do this **before** sending value. Trust the pinned commit + these on-chain checks, never a live endpoint. All addresses are in `addresses.json`; re-check them yourself.

## 1. Morpho Blue core is immutable & official
- `eth_getCode(core)` returns real runtime bytecode (not an EIP-1167 minimal proxy, no EIP-1967 implementation slot → no upgrade path).
- Optional strong check: `forge build` the audited tag of `morpho-org/morpho-blue`, strip trailing CBOR metadata, and compare runtime bytecode to `eth_getCode(core)`. Blue core has no immutable constructor args → expect a byte-for-byte match.
- `core.owner()` == `0x060595638692de6ccd47ca04094f1772d3d39728`. The owner's ONLY powers: `enableIrm`, `enableLltv`, `setFee` (capped at 25% of interest), `setFeeRecipient`, `setOwner`. It **cannot** pause, seize funds, upgrade code, or change an existing market's params. Confirm there is no other admin.

## 2. IRM is the canonical, enabled model
- `market.irm` == `adaptiveCurveIrm` (`0x2BD3…0fa1`).
- `core.isIrmEnabled(market.irm)` == `true`.
- `irm.MORPHO()` == `core`.

## 3. LLTV is an enabled tier
- `core.isLltvEnabled(market.lltv)` == `true`. Solon uses `0.385e18` (38.5%) for stock collateral.

## 4. Oracle is from the official factory + prices sanely
- `market.oracle` was produced by `chainlinkOracleV2Factory` (`0xB7c1…cdF2`).
- `oracle.price()` does not revert and is in a sane range; re-derive the `1e(36+loanDec−collDec)` scale from token `decimals()` and confirm.
- Solon's adapter is fail-closed (reverts on stale/`answer<=0`/`roundId==0`/`answeredInRound<roundId`) and uses the feed's Total-Return value directly (branch A — no double `uiMultiplier`). Pool price is never used for pricing. The source is `adapter/StockOracleAdapter.sol` — byte-diff the deployed adapter against it.

## 5. Vault (only if you deposit for yield)
The factory recognizing a vault proves only that the **shell** is canonical — NOT that its config is safe.
- Confirm the vault is recognized by `vaultV2Factory` (Robinhood Chain uses **Vault V2**, not MetaMorpho v1.1):
  `cast call <vaultV2Factory> "isVaultV2(address)(bool)" <vault>` must return `true`.
- Governance getters on the vault itself (not part of the ERC-4626 ABI): `owner()(address)`,
  `curator()(address)`, `asset()(address)`. Timelocks are per-selector:
  `timelock(bytes4)(uint256)` with the selector of the guarded function.
- Vault shares are 18-decimal even though USDG is 6-decimal: `deposit(3e6 assets)` mints ~`3e18` shares.
- Independently audit `owner`, `curator`, `guardian`/`sentinel`, `timelock`, and **every** market in its supply/withdraw queues and caps. A canonical shell with a hostile curator can still route deposits into a bad market.

## Bottom line
Blue core and the IRM are immutable and audited (OpenZeppelin, Cantina, Certora; IRM re-audited 2025-11 by Blackthorn + Spearbit). The real trust surface is **market creators and vault curators** — that is where an agent spends its scrutiny, every time, before the first transaction.
