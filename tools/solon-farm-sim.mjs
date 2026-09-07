#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Solon farm PRE-BROADCAST SIMULATION (read-only reference tool).
//
// Static-preview a dual-borrow farm operation BEFORE broadcasting: does it revert
// (with which named vault error) and, for open/increase, roughly where does health
// land. Uses eth_call only (viem simulateContract with an address `account`): NO
// wallet client, NO signing, NO transaction, NO private key argument / env lookup /
// key file / stdin. `--params` is inline JSON only. RPC URLs are never printed.
//
// A successful pre-flight proves the vault's on-chain post-action health check passed
// (it reverts UnhealthyOpen/UnhealthyIncrease/... otherwise). The projected health
// number is an ESTIMATE (see farm-project.mjs). A simulation is not a mined result;
// state can change before inclusion.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createPublicClient, http, getAddress,
  BaseError, ContractFunctionRevertedError,
} from 'viem';
import { projectOpenIncrease } from './lib/farm-project.mjs';
import { evalFeed, evalDepeg } from './lib/farm-math.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ABI_DIR = join(HERE, '..', 'abis');

// v1 supports only the deployed/verified dual-v3 shape. Other shapes have different
// param tuples (V4 dual uses amount*Max; single uses amountInvest/amountBorrow/zapPath),
// so encoding them here would silently mis-shape the call — reject rather than guess.
const KIND_ABI = { 'dual-v3': 'uni-v3-dual-vault.json' };
const DUAL = new Set(['dual-v3']);

// Redact the RPC endpoint (and any stray URL, which can carry API keys) from all output.
let RPC_URL = '';
function redact(s) {
  if (typeof s !== 'string') return s;
  let out = RPC_URL ? s.split(RPC_URL).join('<rpc>') : s;
  return out.replace(/https?:\/\/[^\s"'`)]+/gi, '<url>');
}
// Ops that carry a params struct, and how to assemble the viem args array.
const OPS = new Set(['open', 'increase', 'close', 'rebalance', 'addMargin', 'harvest']);

const HELP = `Usage: node tools/solon-farm-sim.mjs --rpc <url> --vault <addr> --from <addr>
  --op open|increase|close|rebalance|addMargin|harvest --params '<inline JSON>'
  [--id <uint> (all ops except open)] [--kind dual-v3 (v1: dual-v3 only)]
  [--block <n>] [--json]
Read-only; no keys, no transactions. --params is inline JSON matching the op tuple (raw units, strings).
Examples of --params per op are in tools/README.md.`;

function fail(msg) { console.error(msg + '\n' + HELP); process.exit(1); }

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) fail(`unexpected token: ${k}`);
    const key = k.slice(2);
    if (key === 'json') { a.json = true; continue; }
    const v = argv[++i];
    if (v === undefined) fail(`missing value for --${key}`);
    a[key] = v;
  }
  return a;
}

function loadAbi(kind) {
  const raw = JSON.parse(readFileSync(join(ABI_DIR, KIND_ABI[kind]), 'utf8'));
  return Array.isArray(raw) ? raw : raw.abi;
}

// Assemble the viem args array for an op from an id and the inline params object.
// Amount fields must be strings or safe integers — an unquoted JSON bigint loses
// precision at parse time, so we reject unsafe JS numbers rather than encode a wrong amount.
function asBig(k, v, op) {
  if (v === undefined) fail(`--params missing "${k}" for op ${op}`);
  if (typeof v === 'number' && !Number.isSafeInteger(v)) fail(`--params "${k}" is an unsafe number; pass it as a string`);
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'bigint') fail(`--params "${k}" must be a string integer`);
  try { return BigInt(v); } catch { fail(`--params "${k}" is not an integer`); }
}
function asInt24(k, v, op) {
  const b = asBig(k, v, op);
  if (b < -8388608n || b > 8388607n) fail(`--params "${k}" out of int24 range`);
  return Number(b);
}
// Signed int256 field (rebalance swapAmount): may be negative; string required for large magnitudes.
function signedBig(k, v, op) {
  if (v === undefined) fail(`--params missing "${k}" for op ${op}`);
  if (typeof v === 'number' && !Number.isSafeInteger(v)) fail(`--params "${k}" is an unsafe number; pass it as a string`);
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'bigint') fail(`--params "${k}" must be a string integer`);
  try { return BigInt(v); } catch { fail(`--params "${k}" is not an integer`); }
}
// Strict boolean: only real booleans or the strings "true"/"false"; no truthy coercion.
function strictBool(k, v, op) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  fail(`--params "${k}" must be boolean true/false for op ${op}`);
}
function buildArgs(op, id, p) {
  const S = (k) => asBig(k, p[k], op);
  const I = (k) => asInt24(k, p[k], op);
  const B = (k) => {
    const v = p[k];
    if (v === undefined || v === '0x') return '0x';
    if (typeof v !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(v)) fail(`--params "${k}" must be 0x-prefixed hex bytes`);
    return v;
  };
  switch (op) {
    case 'open':
      return [{ investRisk: S('investRisk'), investLoan: S('investLoan'), borrowRisk: S('borrowRisk'),
        borrowLoan: S('borrowLoan'), tickLower: I('tickLower'), tickUpper: I('tickUpper'),
        amount0Min: S('amount0Min'), amount1Min: S('amount1Min'), minLiquidity: S('minLiquidity'),
        deadline: S('deadline') }];
    case 'increase':
      return [id, { investRisk: S('investRisk'), investLoan: S('investLoan'), borrowRisk: S('borrowRisk'),
        borrowLoan: S('borrowLoan'), amount0Min: S('amount0Min'), amount1Min: S('amount1Min'),
        minLiquidity: S('minLiquidity'), deadline: S('deadline') }];
    case 'close':
      return [id, { percent: I('percent'), topUpRisk: S('topUpRisk'), topUpLoan: S('topUpLoan'),
        maxSwapIn: S('maxSwapIn'), minOutRisk: S('minOutRisk'), minOutLoan: S('minOutLoan'),
        zapPath: B('zapPath'), deadline: S('deadline') }];
    case 'rebalance':
      return [id, { newTickLower: I('newTickLower'), newTickUpper: I('newTickUpper'),
        swapAmount: signedBig('swapAmount', p.swapAmount, op), minSwapOut: S('minSwapOut'), minLiquidity: S('minLiquidity'),
        zapPath: B('zapPath'), deadline: S('deadline') }];
    case 'addMargin':
      return [id, S('amountRisk'), S('amountLoan')];
    case 'harvest':
      return [id, strictBool('compound', p.compound), S('deadline')];
    default: fail(`unknown op: ${op}`);
  }
}

// Walk a viem error for a decoded custom/standard revert. isRevert=true only when the
// contract actually reverted (with or without decodable data); false for transport/state/
// encoding failures, which must not be labeled a revert verdict.
function decodeRevert(err) {
  if (err instanceof BaseError) {
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError) {
      const name = rev.data?.errorName ?? rev.reason ?? null;
      const args = rev.data?.args ?? null;
      return { isRevert: true, name, args: args ? args.map((x) => (typeof x === 'bigint' ? x.toString() : x)) : null,
        signature: rev.signature ?? null, short: rev.shortMessage };
    }
    return { isRevert: false, name: null, args: null, signature: null, short: err.shortMessage };
  }
  return { isRevert: false, name: null, args: null, signature: null, short: String(err?.message ?? err) };
}

// Post-action health enforcement differs per op — do not claim a blanket "health proven".
function caveatFor(op) {
  const base = 'Read-only static preview via eth_call; no transaction is sent. A simulation is not a mined-result guarantee; state can change before inclusion.';
  if (op === 'open' || op === 'increase' || op === 'close' || op === 'rebalance')
    return 'A successful pre-flight means this call would not revert at this block, so the vault\'s enforced post-action health check passed. The projected health number is an OPTIMISTIC estimate (see projection caveats). ' + base;
  if (op === 'addMargin')
    return 'addMargin only repays debt (no LP mint, no oracle/health check), so a successful pre-flight does NOT assert any health level — it strictly reduces debt. ' + base;
  return 'harvest enforces post-action health for compound; claim paths and fee skims still apply. A successful pre-flight means the call would not revert at this block. ' + base;
}

const HINTS = {
  UnhealthyOpen: 'post-open position would be unhealthy (debt > capacity) — reduce borrow or add equity',
  UnhealthyIncrease: 'post-increase position would be unhealthy — reduce borrow or add equity',
  UnhealthyAfterClose: 'the residual position after this partial close would be unhealthy',
  UnhealthyAfterRebalance: 'post-rebalance position would be unhealthy',
  UnhealthyAfterHarvest: 'post-harvest position would be unhealthy',
  Slippage: 'a token consumption/output minimum was not met at current spot — widen minima or slippage budget',
  SlippageGap: 'the gap-swap output minimum was not met',
  SlippageLiq: 'the liquidity floor (minLiquidity) was not met — lower it or adjust amounts',
  RangeTooNarrow: 'the chosen tick range is narrower than MIN_WIDTH_TICKS',
  TickOutOfRange: 'ticks are misaligned or do not straddle the current tick',
  NotTwoSided: 'the range/amounts do not form a two-sided position at spot',
  ZeroLiq: 'the resulting liquidity would be zero',
  DustLiq: 'the removed/added liquidity rounds to dust',
  NotHolder: 'the --from address does not own this position',
  SolventBadDebt: 'full close with residual debt requires a proven pre-existing insolvency',
  SeizeValueLow: 'liquidation seize value below the minimum',
};

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.rpc) fail('missing --rpc');
  if (!a.vault) fail('missing --vault');
  if (!a.from) fail('missing --from');
  if (!a.op || !OPS.has(a.op)) fail('missing/invalid --op');
  RPC_URL = a.rpc;
  const kind = a.kind ?? 'dual-v3';
  if (!KIND_ABI[kind]) fail(`--kind ${a.kind}: sim v1 supports dual-v3 only (other shapes have different param tuples; use solon-farm-read.mjs to inspect them, and the vault's own post-action checks still apply)`);
  if (a.op !== 'open' && a.id === undefined) fail(`--id is required for op ${a.op}`);
  let params = {};
  if (a.params !== undefined) {
    if (a.params.trim().startsWith('@') || a.params.includes('/')) fail('--params must be inline JSON, not a file path');
    try { params = JSON.parse(a.params); } catch (e) { fail('--params is not valid JSON: ' + e.message); }
  }
  const vault = getAddress(a.vault);
  const from = getAddress(a.from);
  const id = a.op === 'open' ? undefined : BigInt(a.id);
  const abi = loadAbi(kind);
  const client = createPublicClient({ transport: http(a.rpc) });

  const block = await client.getBlock({ blockNumber: a.block !== undefined ? BigInt(a.block) : undefined });
  const blockNumber = block.number;

  // Guard: a codeless address makes void-return calls decode as empty success. Require code.
  const code = await client.getBytecode({ address: vault, blockNumber });
  if (!code || code === '0x') fail(`no contract code at ${vault} at block ${blockNumber} — wrong address or chain`);

  const callArgs = buildArgs(a.op, id, params);

  // ---- CORE: static pre-flight -------------------------------------------------
  let preflight;
  try {
    const { result } = await client.simulateContract({
      address: vault, abi, functionName: a.op, args: callArgs, account: from, blockNumber,
    });
    preflight = { verdict: 'WILL_SUCCEED',
      returned: result === undefined ? null
        : Array.isArray(result) ? result.map((x) => (typeof x === 'bigint' ? x.toString() : x))
        : (typeof result === 'bigint' ? result.toString() : result) };
  } catch (err) {
    const d = decodeRevert(err);
    // Only a decoded contract revert is a verdict about the tx. Transport / historical-state /
    // ABI-encoding failures are NOT reverts — report them as errors so nothing is mislabeled.
    preflight = d.isRevert
      ? { verdict: 'WILL_REVERT', error: d.name, args: d.args, signature: d.signature,
          hint: d.name && HINTS[d.name] ? HINTS[d.name] : null, detail: redact(d.short) }
      : { verdict: 'SIMULATION_ERROR', error: null, detail: redact(d.short),
          note: 'No contract execution result (transport, unavailable historical state, or local encoding). Not a revert verdict.' };
  }

  // ---- Projection (open/increase only) ----------------------------------------
  let projection = null;
  if ((a.op === 'open' || a.op === 'increase') && DUAL.has(kind) && preflight.verdict !== 'SIMULATION_ERROR') {
    projection = await buildProjection({ client, vault, abi, kind, id, op: a.op, params, blockNumber, now: block.timestamp })
      .catch((e) => ({ error: redact(e.message) }));
  }

  const out = {
    tool: 'solon-farm-sim', kind, vault, op: a.op, from, positionId: a.op === 'open' ? null : a.id,
    block: { number: blockNumber.toString(), hash: block.hash },
    preflight, projection, caveat: caveatFor(a.op),
  };

  if (a.json) { console.log(JSON.stringify(out, replacer, 2)); }
  console.error(renderSummary(out));
  if (preflight.verdict === 'WILL_REVERT') process.exitCode = 3;
  else if (preflight.verdict === 'SIMULATION_ERROR') process.exitCode = 4;
}

function replacer(_k, v) { return typeof v === 'bigint' ? v.toString() : v; }

async function buildProjection({ client, vault, abi, kind, id, op, params, blockNumber, now }) {
  const read = (functionName, args = []) => client.readContract({ address: vault, abi, functionName, args, blockNumber });
  const [loanIsC0, lltv, oracleAddr, token0, token1] = await Promise.all([
    read('LOAN_IS_C0'), read('LLTV'), read('ORACLE'), read('TOKEN0'), read('TOKEN1'),
  ]);
  const riskIsToken0 = !loanIsC0;
  const erc20 = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }];
  const [dec0, dec1] = await Promise.all([
    client.readContract({ address: token0, abi: erc20, functionName: 'decimals', blockNumber }),
    client.readContract({ address: token1, abi: erc20, functionName: 'decimals', blockNumber }),
  ]);
  const ug = (name, type) => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type }] });
  const oracleAbi = [ug('RISK_FEED', 'address'), ug('LOAN_FEED', 'address'),
    ug('RISK_MAX_STALENESS', 'uint256'), ug('STABLE_MAX_STALENESS', 'uint256'), ug('STABLE_DEPEG_BPS', 'uint256')];
  const oread = (fn) => client.readContract({ address: oracleAddr, abi: oracleAbi, functionName: fn, blockNumber });
  const [riskFeed, loanFeed, riskMaxStale, stableMaxStale, depegBps] = await Promise.all([
    oread('RISK_FEED'), oread('LOAN_FEED'), oread('RISK_MAX_STALENESS'), oread('STABLE_MAX_STALENESS'), oread('STABLE_DEPEG_BPS'),
  ]);
  const feedAbi = [{ type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [],
      outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
    ug('decimals', 'uint8')];
  const feed = async (addr) => {
    const [round, decimals] = await Promise.all([
      client.readContract({ address: addr, abi: feedAbi, functionName: 'latestRoundData', blockNumber }),
      client.readContract({ address: addr, abi: feedAbi, functionName: 'decimals', blockNumber }),
    ]);
    return { roundId: round[0], answer: round[1], updatedAt: round[3], answeredInRound: round[4], decimals: BigInt(decimals) };
  };
  const [risk, loan] = await Promise.all([feed(riskFeed), feed(loanFeed)]);

  // Fail closed: do not project a health number from a feed that is stale, invalid, or de-pegged.
  const rf = evalFeed({ answer: risk.answer, updatedAt: risk.updatedAt, roundId: risk.roundId,
    answeredInRound: risk.answeredInRound, now, maxStaleness: riskMaxStale });
  const lf = evalFeed({ answer: loan.answer, updatedAt: loan.updatedAt, roundId: loan.roundId,
    answeredInRound: loan.answeredInRound, now, maxStaleness: stableMaxStale });
  if (rf.failClosed) throw new Error(`risk feed unusable (${rf.reason}); refusing to project health from a bad feed`);
  if (lf.failClosed) throw new Error(`loan feed unusable (${lf.reason}); refusing to project health from a bad feed`);
  if (risk.decimals !== loan.decimals) throw new Error(`feed decimals differ (risk ${risk.decimals} vs loan ${loan.decimals}); oracle valuation assumes equal feed decimals`);
  const depeg = evalDepeg({ usdgPrice: loan.answer, depegBps, feedDecimals: loan.decimals });
  if (!depeg.inBand) throw new Error(`loan (USDG) de-pegged ${depeg.deviationBps} bps > band ${depegBps}; refusing to project`);

  const riskPrice = risk.answer, loanPrice = loan.answer;
  const base = { op, riskPrice, loanPrice, dec0: BigInt(dec0), dec1: BigInt(dec1), riskIsToken0, lltv,
    investRisk: params.investRisk ?? 0n, investLoan: params.investLoan ?? 0n,
    borrowRisk: params.borrowRisk ?? 0n, borrowLoan: params.borrowLoan ?? 0n };

  if (op === 'open') {
    return normalizeProjection(projectOpenIncrease({ ...base,
      newTickLower: Number(params.tickLower), newTickUpper: Number(params.tickUpper) }));
  }
  // increase: read current position + raw leg debts
  const pos = await read('positions', [id]);
  const [, liquidity, tickLower, tickUpper, debtRiskId, debtLoanId] = pos;
  const lendingPool = await read('LENDING_POOL');
  const lendAbi = [{ type: 'function', name: 'getCurrentDebt', stateMutability: 'view',
    inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] }];
  const [dRisk, dLoan] = await Promise.all([
    client.readContract({ address: lendingPool, abi: lendAbi, functionName: 'getCurrentDebt', args: [debtRiskId], blockNumber }),
    client.readContract({ address: lendingPool, abi: lendAbi, functionName: 'getCurrentDebt', args: [debtLoanId], blockNumber }),
  ]);
  return normalizeProjection(projectOpenIncrease({ ...base,
    liquidity, tickLower: Number(tickLower), tickUpper: Number(tickUpper), dRisk, dLoan }));
}

function normalizeProjection(r) {
  const fmt = (o) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
  return { estimate: true, addedLiquidity: r.addedLiquidity.toString(),
    current: fmt(r.current), projected: fmt(r.projected), caveats: r.caveats };
}

function pct(bps) { return bps === null || bps === undefined ? '∞/inactive' : (Number(bps) / 100).toFixed(2) + '%'; }

function renderSummary(o) {
  const L = [];
  L.push(`Solon sim | ${o.kind} | op ${o.op}${o.positionId !== null ? ' | position ' + o.positionId : ''} | from ${o.from}`);
  L.push(`block ${o.block.number} (${o.block.hash})`);
  if (o.preflight.verdict === 'WILL_SUCCEED') {
    L.push(`PRE-FLIGHT: WILL_SUCCEED` + (o.preflight.returned !== null ? ` | returns ${JSON.stringify(o.preflight.returned)}` : ''));
  } else if (o.preflight.verdict === 'WILL_REVERT') {
    L.push(`PRE-FLIGHT: WILL_REVERT | ${o.preflight.error ?? '(revert, no decodable data)'}` +
      (o.preflight.args ? ` ${JSON.stringify(o.preflight.args)}` : ''));
    if (o.preflight.hint) L.push(`  hint: ${o.preflight.hint}`);
    if (!o.preflight.error && o.preflight.detail) L.push(`  detail: ${o.preflight.detail}`);
  } else {
    L.push(`PRE-FLIGHT: SIMULATION_ERROR (not a revert) | ${o.preflight.detail ?? ''}`);
    if (o.preflight.note) L.push(`  ${o.preflight.note}`);
  }
  if (o.projection && !o.projection.error) {
    const p = o.projection.projected;
    L.push(`PROJECTED health (estimate): utilization ${pct(p.healthBps)} | isHealthy ${p.isHealthy} | V ${p.valueInLoan} / D ${p.debtInLoan} LOAN raw`);
    L.push(`  headroom ${p.headroom} | +liquidity ${o.projection.addedLiquidity}` + (o.projection.current ? ` | current util ${pct(o.projection.current.healthBps)}` : ''));
  } else if (o.projection && o.projection.error) {
    L.push(`PROJECTED health: unavailable (${o.projection.error})`);
  }
  L.push(o.caveat);
  return L.join('\n');
}

main().catch((error) => {
  const reason = error?.message ? ` ${redact(String(error.message))}` : '';
  console.error('Simulation failed; no reliable preview produced.' + reason +
    '\nCheck arguments, --params JSON, pinned-block RPC availability, and vault kind.\n' + HELP);
  process.exitCode = 1;
});
