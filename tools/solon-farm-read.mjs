#!/usr/bin/env node
// Read-only by construction: public client, explicit view/pure ABI guard, no account.
import { readFile } from 'node:fs/promises';
import { createPublicClient, http, isAddress, zeroAddress, formatUnits } from 'viem';
import {
  healthUtilization, tickToPrice, dualLiquidationBoundaries,
  singleLiquidationBoundary, fairPositionAtRiskPrice, evalFeed, evalDepeg,
} from './lib/farm-math.mjs';

class ReaderError extends Error {}

const KINDS = {
  'dual-v3': 'uni-v3-dual-vault', 'dual-v4': 'uni-v4-dual-vault',
  'single-v3': 'uni-v3-leverage-vault', 'single-v4': 'uni-v4-leverage-vault',
};
// Exact IStateView declaration: leverage/src/UniV4DualVault.sol:54-57 and
// UniV4LeverageVault.sol:43-46. No StateView ABI is shipped in ../abis/.
const STATE_VIEW_ABI = [{ type: 'function', name: 'getSlot0', stateMutability: 'view',
  inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
    { name: 'protocolFee', type: 'uint24' }, { name: 'lpFee', type: 'uint24' },
  ] }];
const HELP = `Usage: node tools/solon-farm-read.mjs --rpc <http(s) URL> --vault <address> --id <uint256>
  [--kind dual-v3|dual-v4|single-v3|single-v4] [--block <uint>] [--entry '<JSON>'] [--json]
Read-only; no private keys or transactions. --json writes JSON to stdout, summary to stderr.
--entry is inline JSON, never a file path. See tools/README.md for raw-unit schema.`;
const json = (x) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const validAddress = (a) => isAddress(a, { strict: false }) && !same(a, zeroAddress);
function uint(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new ReaderError(`${label} must be a decimal integer string`);
  const n = BigInt(value);
  if (n >= 1n << 256n) throw new ReaderError(`${label} exceeds uint256`);
  return n;
}
function argsOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--rpc', '--vault', '--id', '--kind', '--block', '--entry', '--json', '--help'].includes(key)) {
      throw new ReaderError('Unknown argument; only documented read-only flags are accepted');
    }
    if (Object.hasOwn(args, key)) throw new ReaderError(`Duplicate ${key}`);
    if (key === '--json' || key === '--help') args[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new ReaderError(`Missing value for ${key}`);
      args[key] = argv[++i];
    }
  }
  if (args['--help']) return args;
  if (!args['--rpc'] || !args['--vault'] || !args['--id']) throw new ReaderError('Required: --rpc, --vault, --id');
  const url = new URL(args['--rpc']);
  if (!['http:', 'https:'].includes(url.protocol)) throw new ReaderError('RPC must be http(s)');
  if (!validAddress(args['--vault'])) throw new ReaderError('Invalid/zero vault address');
  args.id = uint(args['--id'], '--id');
  if (args['--block'] !== undefined) args.blockNumber = uint(args['--block'], '--block');
  if (args['--kind'] && !Object.hasOwn(KINDS, args['--kind'])) throw new ReaderError('Unsupported --kind');
  if (args['--entry']) args.entry = parseEntry(args['--entry']);
  return args;
}
function parseEntry(input) {
  let e;
  try { e = JSON.parse(input); } catch { throw new ReaderError('--entry must be inline JSON'); }
  if (!e || Array.isArray(e) || typeof e !== 'object') throw new ReaderError('Invalid entry object');
  const keys = ['chainId', 'vault', 'positionId', 'blockNumber', 'netEquityLoan', 'netDepositsLoan', 'withdrawalsLoan'];
  if (Object.keys(e).some(k => !keys.includes(k))) throw new ReaderError('Unknown entry field');
  if (!validAddress(e.vault)) throw new ReaderError('Invalid entry vault');
  for (const key of ['chainId', 'positionId', 'blockNumber', 'netDepositsLoan', 'withdrawalsLoan']) {
    e[key] = uint(e[key] ?? (['netDepositsLoan', 'withdrawalsLoan'].includes(key) ? '0' : undefined), `entry.${key}`);
  }
  if (typeof e.netEquityLoan !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(e.netEquityLoan)) {
    throw new ReaderError('entry.netEquityLoan must be a signed raw-unit decimal string');
  }
  e.netEquityLoan = BigInt(e.netEquityLoan);
  return e;
}
async function loadAbi(name) {
  const parsed = JSON.parse(await readFile(new URL(`../abis/${name}.json`, import.meta.url), 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.abi;
}
function namedResult(abi, name, value) {
  const outputs = abi.find(x => x.type === 'function' && x.name === name).outputs;
  if (outputs.length <= 1) return value;
  return Object.fromEntries(outputs.map((out, i) => [out.name || `field${i}`, value[i]]));
}
// Every numeric leaf carries its read/derivation block. Historical entry numbers
// are separately marked user-supplied, not falsely attributed to eth_call.
function tagNumbers(value, block, source = 'pinned-block') {
  if (typeof value === 'bigint' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new ReaderError('Unsafe decoded integer');
    return { value: String(value), blockNumber: String(block.number), blockHash: block.hash, source };
  }
  if (Array.isArray(value)) return value.map(v => tagNumbers(v, block, source));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tagNumbers(v, block, source)]));
  return value;
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args['--help']) { console.log(HELP); return; }
  const vault = args['--vault'];
  const client = createPublicClient({ transport: http(args['--rpc'], { timeout: 15_000, retryCount: 0 }), batch: { multicall: false } });
  // getChainId returns a bounded Number; JSON-RPC quantity keeps the original integer.
  const chainId = BigInt(await client.request({ method: 'eth_chainId' }));
  const block = await client.getBlock(args.blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber: args.blockNumber });
  if (block.number === null || !block.hash) throw new ReaderError('Cannot pin a pending block');
  if (args.entry && (args.entry.chainId !== chainId || !same(args.entry.vault, vault)
    || args.entry.positionId !== args.id || args.entry.blockNumber > block.number)) {
    throw new ReaderError('Entry chain/vault/id must match, and entry block must not be in the future');
  }
  const reads = [];
  const warnings = ['Runtime/source identity is not certified by getter probes; cross-check deployment bytecode independently.'];
  const failures = [];
  const abis = Object.fromEntries(await Promise.all(Object.entries(KINDS).map(async ([k, n]) => [k, await loadAbi(n)])));
  const [oracleAbi, lendingAbi, tokenAbi, feedAbi, poolAbi] = await Promise.all([
    'lp-share-oracle-v4', 'lending-pool', 'erc20', 'farm-chainlink-feed', 'farm-v3-pool',
  ].map(loadAbi));
  async function read(address, abi, name, params = [], optional = false) {
    if (!validAddress(address)) throw new ReaderError(`Invalid address for ${name}`);
    const declaration = abi.find(x => x.type === 'function' && x.name === name);
    if (!declaration || !['view', 'pure'].includes(declaration.stateMutability)) throw new ReaderError(`Non-read or absent ABI function: ${name}`);
    const record = { address, function: name, args: params };
    reads.push(record);
    try {
      const result = await client.readContract({ address, abi, functionName: name, args: params, blockNumber: block.number });
      record.value = namedResult(abi, name, result);
      record.status = 'ok';
      return record.value;
    } catch {
      // Do not print transport errors: they can contain credential-bearing RPC URLs.
      record.status = 'failed';
      record.error = 'eth_call failed or response could not be decoded';
      if (!optional) failures.push(`${name} at ${address}: read failed`);
      return null;
    }
  }
  const codeChecks = [];
  async function requireCode(address, label) {
    if (!validAddress(address)) throw new ReaderError(`Invalid ${label} address`);
    const code = await client.getCode({ address, blockNumber: block.number });
    codeChecks.push({ address, label, hasCode: !!code && code !== '0x' });
    if (!code || code === '0x') throw new ReaderError(`No runtime bytecode for ${label} at pinned block`);
  }
  await requireCode(vault, 'vault');
  // Positive probes on BOTH axes: RPC/revert failures never imply a default kind.
  const [reserveRisk, reserveLoan, reserveSingle, poolV3, poolV4] = await Promise.all([
    read(vault, abis['dual-v3'], 'RESERVE_RISK', [], true),
    read(vault, abis['dual-v3'], 'RESERVE_LOAN', [], true),
    read(vault, abis['single-v3'], 'RESERVE_ID', [], true),
    read(vault, abis['dual-v3'], 'POOL', [], true),
    read(vault, abis['dual-v4'], 'POOL_ID', [], true),
  ]);
  const isDual = reserveRisk !== null && reserveLoan !== null;
  const isSingle = reserveSingle !== null;
  if (isDual === isSingle || (poolV3 !== null) === (poolV4 !== null)) throw new ReaderError('Kind probes ambiguous/failed; cannot resolve vault shape');
  const kind = `${isDual ? 'dual' : 'single'}-${poolV3 !== null ? 'v3' : 'v4'}`;
  if (args['--kind'] && args['--kind'] !== kind) throw new ReaderError('--kind disagrees with positive getter probes');
  const abi = abis[kind];
  const getters = ['LENDING_POOL', 'ORACLE', 'TOKEN0', 'TOKEN1', 'LOAN', 'RISK', 'LOAN_IS_C0', 'LLTV'];
  const config = Object.fromEntries(await Promise.all(getters.map(async n => [n, await read(vault, abi, n)])));
  if (Object.values(config).some(x => x === null)) throw new ReaderError('Required vault configuration read failed');
  const [owner, position] = await Promise.all([read(vault, abi, 'ownerOf', [args.id]), read(vault, abi, 'positions', [args.id])]);
  if (owner === null || position === null) throw new ReaderError('Position/owner read failed');
  if (!same(config.LOAN, config.LOAN_IS_C0 ? config.TOKEN0 : config.TOKEN1)
    || !same(config.RISK, config.LOAN_IS_C0 ? config.TOKEN1 : config.TOKEN0) || same(config.TOKEN0, config.TOKEN1)) {
    throw new ReaderError('Vault token ordering is inconsistent');
  }
  for (const n of ['LENDING_POOL', 'ORACLE', 'TOKEN0', 'TOKEN1']) await requireCode(config[n], n);
  const [dec0Raw, dec1Raw] = await Promise.all([read(config.TOKEN0, tokenAbi, 'decimals'), read(config.TOKEN1, tokenAbi, 'decimals')]);
  if (dec0Raw === null || dec1Raw === null) throw new ReaderError('Token decimals unavailable');
  const dec0 = BigInt(dec0Raw), dec1 = BigInt(dec1Raw);
  const loanDec = config.LOAN_IS_C0 ? dec0 : dec1;
  const debtIds = isDual ? { risk: position.debtRisk, loan: position.debtLoan } : { loan: position.debtId };
  const debts = Object.fromEntries(await Promise.all(Object.entries(debtIds).map(async ([leg, id]) => [leg, {
    debtId: id, ...await read(config.LENDING_POOL, lendingAbi, 'getCurrentDebt', [id]),
  }])));
  // getCurrentDebt(0) can revert (zero stored index); never silently turn it into zero debt.
  const reserveIds = isDual ? { risk: reserveRisk, loan: reserveLoan } : { loan: reserveSingle };
  const reserves = Object.fromEntries(await Promise.all(Object.entries(reserveIds).map(async ([leg, id]) => [leg, {
    reserveId: id,
    token: await read(config.LENDING_POOL, lendingAbi, 'getUnderlyingTokenAddress', [id]),
    borrowAprWad: await read(config.LENDING_POOL, lendingAbi, 'borrowingRateOfReserve', [id]),
  }])));
  for (const [leg, r] of Object.entries(reserves)) if (!same(r.token, leg === 'risk' ? config.RISK : config.LOAN)) failures.push(`${leg} reserve token mismatch`);
  let spot;
  if (kind.endsWith('v3')) {
    await requireCode(poolV3, 'V3 pool');
    spot = { pool: poolV3, ...await read(poolV3, poolAbi, 'slot0') };
  } else {
    const stateView = await read(vault, abi, 'STATE_VIEW');
    await requireCode(stateView, 'V4 StateView');
    spot = { stateView, poolId: poolV4, ...await read(stateView, STATE_VIEW_ABI, 'getSlot0', [poolV4]) };
  }
  if (spot.tick !== undefined) spot.riskPriceAtTick = tickToPrice(BigInt(spot.tick), dec0, dec1, !config.LOAN_IS_C0);
  const oracleGetters = ['FEED0', 'FEED1', 'LOAN_FEED', 'RISK_FEED', 'DEC0', 'DEC1', 'LOAN_DEC', 'RISK_DEC',
    'RISK_MAX_STALENESS', 'STABLE_MAX_STALENESS', 'STABLE_DEPEG_BPS'];
  const oracle = Object.fromEntries(await Promise.all(oracleGetters.map(async n => [n, await read(config.ORACLE, oracleAbi, n)])));
  const oracleComplete = Object.values(oracle).every(x => x !== null);
  const feeds = {};
  for (const leg of ['risk', 'loan']) {
    const address = oracle[`${leg.toUpperCase()}_FEED`];
    if (address === null) { feeds[leg] = { fresh: false, failClosed: true, reason: 'oracle getter unavailable' }; continue; }
    await requireCode(address, `${leg} feed`);
    const [decimals, round] = await Promise.all([read(address, feedAbi, 'decimals'), read(address, feedAbi, 'latestRoundData')]);
    const maxStaleness = oracle[leg === 'risk' ? 'RISK_MAX_STALENESS' : 'STABLE_MAX_STALENESS'];
    feeds[leg] = { address, decimals: decimals === null ? null : BigInt(decimals), ...round, maxStaleness,
      ...(round && maxStaleness !== null ? evalFeed({ ...round, now: block.timestamp, maxStaleness })
        : { fresh: false, failClosed: true, reason: 'feed/config read failed', ageSeconds: null }) };
  }
  let mappingValid = false;
  if (oracleComplete) {
    mappingValid = same(oracle.LOAN_FEED, config.LOAN_IS_C0 ? oracle.FEED0 : oracle.FEED1)
      && same(oracle.RISK_FEED, config.LOAN_IS_C0 ? oracle.FEED1 : oracle.FEED0)
      && !same(oracle.LOAN_FEED, oracle.RISK_FEED)
      && BigInt(oracle.DEC0) === dec0 && BigInt(oracle.DEC1) === dec1
      && BigInt(oracle.LOAN_DEC) === loanDec && BigInt(oracle.RISK_DEC) === (config.LOAN_IS_C0 ? dec1 : dec0)
      && feeds.risk.decimals !== null && feeds.loan.decimals !== null && feeds.risk.decimals === feeds.loan.decimals;
    if (!mappingValid) failures.push('Oracle feed/token/decimal mapping mismatch');
  }
  const depeg = feeds.loan.answer !== undefined && feeds.loan.decimals !== null && oracle.STABLE_DEPEG_BPS !== null
    ? evalDepeg({ usdgPrice: feeds.loan.answer, depegBps: oracle.STABLE_DEPEG_BPS, feedDecimals: feeds.loan.decimals })
    : { inBand: false, deviationBps: null, reason: 'loan feed/config unavailable' };
  const [V, dualD, contractHealthy] = await Promise.all([
    read(vault, abi, 'positionValue', [args.id]),
    isDual ? read(vault, abi, 'totalDebtInLoan', [args.id]) : Promise.resolve(null),
    isDual ? read(vault, abi, 'isHealthy', [args.id]) : Promise.resolve(null),
  ]);
  const D = isDual ? dualD : debts.loan.currentDebt ?? null;
  const feedReliable = oracleComplete && mappingValid && feeds.risk.fresh && feeds.loan.fresh && depeg.inBand;
  const active = !same(owner, zeroAddress) && position.liquidity > 0n;
  if (!active) warnings.push('Nonexistent/burned/zero-liquidity receipt: not an active healthy position. Retained debt IDs may still carry bad debt; inspect BadDebt events.');
  const debtAvailable = Object.values(debts).every(d => d.currentDebt !== undefined);
  let reference = null, boundaries = null;
  let boundaryStatus = 'UNAVAILABLE';
  if (feedReliable && debtAvailable && active && failures.length === 0) {
    const model = { liquidity: position.liquidity, tickLower: BigInt(position.tickLower), tickUpper: BigInt(position.tickUpper),
      dRisk: isDual ? debts.risk.currentDebt : 0n, dLoan: debts.loan.currentDebt, lltv: config.LLTV,
      dec0, dec1, riskIsToken0: !config.LOAN_IS_C0, riskPrice: feeds.risk.answer,
      currentRiskPrice: feeds.risk.answer, loanPrice: feeds.loan.answer, feedDecimals: feeds.loan.decimals };
    try {
      reference = fairPositionAtRiskPrice(model);
      if (reference.valueInLoan !== V || reference.debtInLoan !== D) failures.push('Reference valuation/debt differs from live contract; oracle model is not confirmed');
      else {
        try {
          boundaries = isDual ? dualLiquidationBoundaries(model) : singleLiquidationBoundary(model);
          boundaryStatus = 'ESTIMATE';
        } catch (e) { boundaryStatus = 'SEARCH_FAILED'; warnings.push(`Liquidation search: ${e.message}`); }
      }
    } catch (e) { failures.push(`Reference math rejected input: ${e.message}`); }
  }
  const reliable = feedReliable && debtAvailable && V !== null && D !== null && failures.length === 0;
  const computedHealth = reliable ? healthUtilization(D, V, config.LLTV) : null;
  if (reliable && active && isDual && contractHealthy !== computedHealth.isHealthy) failures.push('Computed isHealthy disagrees with vault');
  const healthReliable = reliable && failures.length === 0;
  if (!healthReliable) { boundaries = null; boundaryStatus = 'UNAVAILABLE'; }
  const equity = healthReliable ? V - D : null;
  const pnl = args.entry && equity !== null ? {
    pnlLoan: equity + args.entry.withdrawalsLoan - args.entry.netEquityLoan - args.entry.netDepositsLoan,
    formula: 'netEquityNow + withdrawalsSinceEntry - entryNetEquity - depositsSinceEntry',
    exclusions: 'Uncollected LP fees, exit swap/slippage, gas and unrealized external-wallet assets; cash flows supplied by caller in LOAN units.',
  } : null;
  const book = JSON.parse(await readFile(new URL('../addresses.json', import.meta.url), 'utf8'));
  const example = book.leveragedFarms.sepoliaExample;
  if (same(vault, example.contracts.uniV3DualVault)) {
    if (chainId !== BigInt(example.chainId)) throw new ReaderError('Recorded Sepolia vault supplied on a different chain');
    for (const [field, expected] of [['LENDING_POOL', 'lendingPool'], ['ORACLE', 'lpShareOracleV4'], ['RISK', 'riskToken'], ['LOAN', 'loanToken']]) {
      if (!same(config[field], example.contracts[expected])) warnings.push(`Sepolia recorded ${field} differs from live wiring`);
    }
  } else warnings.push('Explicit vault is not the address-book Sepolia example; no deployment is asserted for it.');
  const target = book.leveragedFarms.oracleTargetConfig;
  for (const [field, expected] of [['RISK_MAX_STALENESS', target.riskMaxStaleness], ['STABLE_MAX_STALENESS', target.stableMaxStaleness], ['STABLE_DEPEG_BPS', target.stableDepegBps]]) {
    if (oracle[field] !== null && BigInt(oracle[field]) !== BigInt(expected)) warnings.push(`${field} differs from FARM-GUIDE target; displayed verdict uses actual getter`);
  }
  // Number-pinned calls must not silently span a detected reorg. Reject output if
  // the canonical block changed; this still assumes an honest, consistent RPC.
  const finalBlock = await client.getBlock({ blockNumber: block.number });
  if (finalBlock.hash !== block.hash) throw new ReaderError('Pinned block changed during reads; discard snapshot and retry');
  const feedProvenance = Object.fromEntries(Object.entries(feeds).map(([leg, f]) => [leg, {
    address: f.address ?? null, roundId: f.roundId ?? null, updatedAt: f.updatedAt ?? null, ageSeconds: f.ageSeconds ?? null,
  }]));
  const raw = {
    schema: 'solon-farm-read/v1', chainId, block: { number: block.number, hash: block.hash, timestamp: block.timestamp },
    vault, kind, positionId: args.id, owner, active, position, config, decimals: { token0: dec0, token1: dec1, loan: loanDec },
    debts, reserves, spot, oracle, feeds, depeg, codeChecks,
    contract: { positionValue: V, totalDebtInLoan: D, isHealthy: contractHealthy,
      debtMethod: isDual ? 'vault.totalDebtInLoan(id)' : 'LendingPool.getCurrentDebt(positions(id).debtId).currentDebt',
      healthMethod: isDual ? 'computed and cross-checked with isHealthy(id)' : 'computed; single vault exposes no health/isHealthy/totalDebt/previewClose' },
    derived: { status: healthReliable ? (active ? 'RELIABLE_READ' : 'INACTIVE') : 'UNRELIABLE', feedProvenance,
      health: healthReliable ? computedHealth : null, netEquityLoan: equity, reference,
      liquidation: { status: boundaryStatus, boundaries, method: 'Frozen liquidity/ticks/debts/loan feed; risk feed integer lattice; no interest forecast or spot substitution' }, pnl },
    warnings: warnings.sort(), failures: failures.sort(),
    reads: reads.sort((a, b) => {
      const ka = `${a.address.toLowerCase()}/${a.function}/${json(a.args)}`;
      const kb = `${b.address.toLowerCase()}/${b.function}/${json(b.args)}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    }),
  };
  const output = tagNumbers(raw, block);
  if (args.entry) output.entry = tagNumbers(args.entry, { number: args.entry.blockNumber, hash: null }, 'user-supplied-entry-and-subsequent-cash-flows');
  const summary = [
    `Solon ${kind} | position ${args.id} | chain ${chainId} | block ${block.number} (${block.hash})`,
    `Owner: ${owner} | ${active ? 'active' : 'inactive/burned/absent'}`,
    `Health: ${raw.derived.status}${healthReliable ? ` | utilization ${computedHealth.healthBps === null ? computedHealth.note : `${computedHealth.healthBps} bps`} | isHealthy ${active ? computedHealth.isHealthy : 'inactive'}` : ''}`,
    `V: ${V === null ? 'unavailable' : formatUnits(V, Number(loanDec))} LOAN | D: ${D === null ? 'unavailable' : formatUnits(D, Number(loanDec))} LOAN`,
    `Capacity/headroom/equity: ${healthReliable ? [computedHealth.capacity, computedHealth.headroom, equity].map(x => formatUnits(x, Number(loanDec))).join(' / ') : 'unreliable'} LOAN`,
    ...Object.entries(feeds).map(([leg, f]) => `${leg} feed: ${f.fresh ? 'fresh' : 'INVALID'} | round ${f.roundId ?? '?'} | updatedAt ${f.updatedAt ?? '?'} | age ${f.ageSeconds ?? '?'}s | ${f.reason ?? ''}`),
    `USDG depeg: ${depeg.inBand ? 'in band' : 'OUT OF BAND / unavailable'} | deviation ${depeg.deviationBps ?? '?'} bps`,
    `Liquidation: ${boundaryStatus} ${json(boundaries)}`,
    ...(pnl ? [`PnL: ${formatUnits(pnl.pnlLoan, Number(loanDec))} LOAN (caller cash flows; fees/gas/exit costs excluded)`] : []),
    ...warnings.map(x => `Note: ${x}`), ...failures.map(x => `UNRELIABLE: ${x}`),
    'Estimate/reference: cross-check live contract state; a simulation is not a mined result.',
  ].join('\n');
  if (args['--json']) { console.error(summary); console.log(json(output)); }
  else console.log(summary);
  if (!healthReliable) process.exitCode = 2;
}

main().catch((error) => {
  // Deliberately omit raw exception/arguments: an RPC endpoint may contain credentials.
  const reason = error instanceof ReaderError ? ` ${error.message}` : '';
  console.error('Read failed; no reliable snapshot produced.' + reason
    + '\nCheck arguments, pinned-block RPC availability, bytecode and getter compatibility.\n' + HELP);
  process.exitCode = 1;
});
