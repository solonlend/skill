# Leveraged LP Farms Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Extend the existing Solon machine interface with source-accurate dual-borrow LP operations.

**Architecture:** Append AGENT-GUIDE §10 and route it to FARM-GUIDE; preserve all lending text and address entries. Export local compiler ABIs, with source provenance and separate chain-scoped farm addresses.

**Tech Stack:** Markdown, JSON, Python standard library; existing local Foundry artifacts only.

### Task 1: Document the farm interface
- Modify `SKILL.md` with one farm routing sentence; append `AGENT-GUIDE.md` §10.
- Create `FARM-GUIDE.md`: READ views, VERIFY deployment/config, USE exact V3 tuples, approvals, protection limits, health and oracle monitoring.
- Check every tuple against `leverage/src/UniV3DualVault.sol`; independently review economic and execution caveats.

### Task 2: Export ABIs and address records
- Add farm entries to `addresses.json`: mainnet TBD and explicitly unverified Sepolia example from the 2026-09-06 deployment record.
- Create `abis/uni-v3-dual-vault.json`, `uni-v4-dual-vault.json`, `lp-share-oracle-v4.json`, `lending-pool.json`, `swap-executor-v3.json`, `farm-v3-pool.json`, `farm-chainlink-feed.json` and `abis/FARM-ABI-SOURCES.json`.
- Compare compiler metadata source keccak hashes to local source before export; preserve full ABI tuples, views, events and errors.

### Task 3: Offline verification
- Compare exported JSON to compiler ABI, documented structs and call signatures to source; verify all existing lending files/entries remain unchanged except append-only routing.
- Check address literals against the Sepolia source record, mainnet placeholders, local links and `git diff --check`.
- No application code is changed; validation covers generated interfaces and documentation. Do not add dependencies, access the network, commit or push.
