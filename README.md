# solon-skill

The machine interface to **Solon** — the bank an AI agent runs by itself. Borrow USDG against tokenized US stocks, or earn on USDG deposits, on Robinhood Chain (chainId 4663), by calling immutable [Morpho](https://morpho.org) contracts directly.

This repository **is** the interface. There is no API of ours in the loop. An autonomous agent installs this repo as a skill, pins a commit, verifies every address on-chain, and transacts with its own wallet.

## Why a repo, not a hosted file
A file served from a website is a mutable trust root: whoever controls the server can change what an agent reads. This repo is pinned to a commit hash — an agent can diff it, mirror it, and verify every contract address on-chain. **Trust the pinned commit + on-chain verification, never a live endpoint.** The website (`solonlend.xyz`) is only a pointer to this repo.

## Contents
| File | What it is |
|---|---|
| [`SKILL.md`](./SKILL.md) | Agent entry point: when to use / when not, the read→verify→use flow, gotchas, safety rules |
| [`AGENT-GUIDE.md`](./AGENT-GUIDE.md) | Full per-module reference (read / verify / use) + a live worked example |
| [`VERIFY.md`](./VERIFY.md) | "Is this really the official, unmodified Morpho?" — the on-chain checklist |
| [`addresses.json`](./addresses.json) | Pinned Robinhood Chain addresses (machine-readable — verify on-chain) |
| [`abis/`](./abis/) | Minimal ABIs for the calls an agent makes |
| [`adapter/`](./adapter/) | `StockOracleAdapter.sol` — Solon's only self-written on-chain code (open, byte-diffable) |

## Trust & attribution
Built on Morpho Blue (GPL-2.0) and Morpho Vault V2. "Built on Morpho" is nominative use — **not affiliated with or endorsed by Morpho**. Morpho core and the IRM are immutable and audited; Solon adds ~80 lines (the oracle adapter) and a curated vault config. All Solon-authored middleware is open source. CODE IS LAW.

## Access policy
Not offered to persons/entities in the United States, China, or sanctioned jurisdictions. Circumventing geo-restriction (VPN, proxy, direct calls) is a knowing violation by the accessing party — human or agent.

*This repo is licensed GPL-2.0, matching the Morpho code it builds on.*
