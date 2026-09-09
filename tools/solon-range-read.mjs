#!/usr/bin/env node
// Solon Range Vaults (CLM) reference reader — read-only, no keys, single pinned block.
// Usage: node solon-range-read.mjs --rpc <url> --vault <addr> [--account <addr>] [--json]
// Reads the vault + its strategy: balances, totalSupply, share value, calm state, managed range,
// pool price; with --account also the account's shares and previewWithdraw amounts.
// Exit codes: 0 snapshot produced, 1 arguments/transport failure.
import { createPublicClient, http, formatUnits } from 'viem';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? 'true' : process.argv[++i]; args[k] = v; }
}
const die = (m) => { console.error(m); process.exit(1); };
if (!args.rpc || !/^0x[0-9a-fA-F]{40}$/.test(args.vault ?? '')) die('need --rpc and --vault');
if (args.account && !/^0x[0-9a-fA-F]{40}$/.test(args.account)) die('bad --account');

const pub = createPublicClient({ transport: http(args.rpc, { timeout: 15_000 }) });
const vaultAbi = [
  { type: 'function', name: 'strategy', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'wants', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }, { type: 'address' }] },
  { type: 'function', name: 'balances', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isCalm', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'previewWithdraw', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
];
const stratAbi = [
  { type: 'function', name: 'pool', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'range', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'function', name: 'positionMain', stateMutability: 'view', inputs: [], outputs: [{ type: 'int24' }, { type: 'int24' }] },
  { type: 'function', name: 'lastPositionAdjustment', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
];
const erc20Abi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

try {
  const block = await pub.getBlock();
  const at = { blockNumber: block.number };
  const rd = (address, abi, functionName, fnArgs = []) => pub.readContract({ address, abi, functionName, args: fnArgs, ...at });

  const strategy = await rd(args.vault, vaultAbi, 'strategy');
  const [t0, t1] = await rd(args.vault, vaultAbi, 'wants');
  const [bal, supply, calm, pool, priceRaw, rangeRaw, mainTicks, lastAdj, paused, s0, d0, s1, d1] = await Promise.all([
    rd(args.vault, vaultAbi, 'balances'), rd(args.vault, vaultAbi, 'totalSupply'), rd(args.vault, vaultAbi, 'isCalm'),
    rd(strategy, stratAbi, 'pool'), rd(strategy, stratAbi, 'price'), rd(strategy, stratAbi, 'range'),
    rd(strategy, stratAbi, 'positionMain'), rd(strategy, stratAbi, 'lastPositionAdjustment'), rd(strategy, stratAbi, 'paused'),
    rd(t0, erc20Abi, 'symbol'), rd(t0, erc20Abi, 'decimals'), rd(t1, erc20Abi, 'symbol'), rd(t1, erc20Abi, 'decimals'),
  ]);
  const toHuman = (p) => (Number(p) / 1e36) * 10 ** (d0 - d1);

  const out = {
    schema: 'solon-range-read/v1',
    block: { number: String(block.number), hash: block.hash, timestamp: String(block.timestamp) },
    vault: args.vault, strategy, pool,
    token0: { address: t0, symbol: s0, decimals: d0 },
    token1: { address: t1, symbol: s1, decimals: d1 },
    balances: { amount0: String(bal[0]), amount1: String(bal[1]) },
    totalSupply: String(supply),
    isCalm: calm, paused,
    price_token1_per_token0: toHuman(priceRaw),
    managedRange: { lowerPrice: toHuman(rangeRaw[0]), upperPrice: toHuman(rangeRaw[1]), tickLower: mainTicks[0], tickUpper: mainTicks[1] },
    lastPositionAdjustment: String(lastAdj),
  };
  if (args.account) {
    const shares = await rd(args.vault, vaultAbi, 'balanceOf', [args.account]);
    out.account = { address: args.account, shares: String(shares) };
    if (shares > 0n && supply > 0n) {
      const pw = await rd(args.vault, vaultAbi, 'previewWithdraw', [shares]);
      out.account.previewWithdraw = { amount0: String(pw[0]), amount1: String(pw[1]) };
    }
  }
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`Range vault ${args.vault} @ block ${out.block.number}`);
    console.log(`  pair: ${s0}/${s1} · pool ${pool}`);
    console.log(`  TVL: ${formatUnits(bal[0], d0)} ${s0} + ${formatUnits(bal[1], d1)} ${s1} · supply ${formatUnits(supply, d1)} shares`);
    console.log(`  price: ${out.price_token1_per_token0.toFixed(2)} ${s1}/${s0} · range ${out.managedRange.lowerPrice.toFixed(2)}–${out.managedRange.upperPrice.toFixed(2)}`);
    console.log(`  calm: ${calm} · paused: ${paused} · lastAdjust: ${new Date(Number(lastAdj) * 1000).toISOString()}`);
    if (out.account) {
      console.log(`  account ${args.account}: ${formatUnits(BigInt(out.account.shares), d1)} shares` +
        (out.account.previewWithdraw ? ` → ${formatUnits(BigInt(out.account.previewWithdraw.amount0), d0)} ${s0} + ${formatUnits(BigInt(out.account.previewWithdraw.amount1), d1)} ${s1}` : ''));
    }
  }
} catch (e) {
  die(`read failed: ${String(e.message ?? e).slice(0, 200)}`);
}
