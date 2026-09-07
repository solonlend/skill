#!/usr/bin/env node
// Read-only Morpho market snapshot. No wallet client, keys, env credentials,
// simulation, accrueInterest transaction, or transaction submission.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPublicClient, http, parseAbi, keccak256, encodeAbiParameters, toHex, zeroAddress, formatUnits } from 'viem';
import { WAD, SECONDS_PER_YEAR, apyFromRate, utilization, supplyApy, deriveOracleScale,
  sharesToAssets, lendingHealth } from './lib/market-math.mjs';

const HELP = `Usage: node tools/solon-market.mjs --market <bytes32> --rpc <url>
  [--account <address>] [--block <decimal block number>] [--json]
Read-only. Human summary goes to stderr; --json emits the snapshot to stdout.
APY: frozen per-second rate, 365-day discrete compounding, WAD floor per multiply.
Health and share assets use stored market totals, WITHOUT pending interest accrual.
Exit: 0 complete checks; 2 incomplete/failed verification or read; 1 no coherent snapshot.`;
class ReaderError extends Error {}
let RPC_URL = '';
let jsonRequested = false;
let pinned = null;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const idPattern = /^0x[0-9a-fA-F]{64}$/;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const validAddress = a => typeof a === 'string' && addressPattern.test(a);
const nonzeroAddress = a => validAddress(a) && !same(a, zeroAddress);
const json = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2);
function redact(value) {
  let text = String(value);
  if (RPC_URL) text = text.split(RPC_URL).join('<rpc>');
  return text.replace(/https?:\/\/[^\s"'`)]+/gi, '<url>');
}

function parseArgs(argv) {
  const args = {};
  const valueFlags = new Set(['--market', '--rpc', '--account', '--block']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (Object.hasOwn(args, flag)) throw new ReaderError('Duplicate option');
    if (flag === '--json' || flag === '--help') args[flag] = true;
    else if (valueFlags.has(flag)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new ReaderError('Missing option value');
      args[flag] = argv[++i];
    } else throw new ReaderError('Unknown option; only the documented read-only options are accepted');
  }
  if (args['--help']) return args;
  if (!idPattern.test(args['--market'] ?? '')) throw new ReaderError('--market must be bytes32');
  if (!args['--rpc']) throw new ReaderError('--rpc is required');
  RPC_URL = args['--rpc'];
  try {
    if (!['http:', 'https:'].includes(new URL(RPC_URL).protocol)) throw new Error();
  } catch { throw new ReaderError('--rpc must be an HTTP(S) URL'); }
  if (args['--account'] !== undefined && !validAddress(args['--account'])) throw new ReaderError('Invalid --account');
  if (args['--block'] !== undefined && !/^\d+$/.test(args['--block'])) throw new ReaderError('--block must be an unsigned decimal integer');
  return args;
}

// EIP-1967 specifies bytes32(uint256(keccak256(label)) - 1). Derive both
// standard slots instead of guessing token-specific storage layout.
const slotFor = label => toHex(BigInt(keccak256(toHex(label))) - 1n, { size: 32 });
const IMPLEMENTATION_SLOT = slotFor('eip1967.proxy.implementation');
const BEACON_SLOT = slotFor('eip1967.proxy.beacon');
const TOKEN_BEACON = '0xe10b6f6b275de231345c20d14ab812db62151b00';
const ZERO_SLOT = `0x${'0'.repeat(64)}`;
const PARAM_NAMES = ['loanToken', 'collateralToken', 'oracle', 'irm', 'lltv'];
const MARKET_NAMES = ['totalSupplyAssets', 'totalSupplyShares', 'totalBorrowAssets', 'totalBorrowShares', 'lastUpdate', 'fee'];
const POSITION_NAMES = ['supplyShares', 'borrowShares', 'collateral'];
const PARAM_TYPES = ['address', 'address', 'address', 'address', 'uint256'].map(type => ({ type }));
// These optional adapter getters are confirmed by adapter/StockOracleAdapter.sol.
// Round data is confirmed by abis/farm-chainlink-feed.json and IAggregatorV3 there.
const ADAPTER_ABI = parseAbi(['function STOCK_FEED() view returns (address)',
  'function USDG_FEED() view returns (address)', 'function MAX_STALENESS() view returns (uint256)']);

function struct(value, names) {
  if (value === null) return null;
  // viem returns an array for flat multi-outputs, an object for a named tuple.
  const values = names.map((name, i) => Array.isArray(value) ? value[i] : value?.[name]);
  if (values.some(v => v === undefined)) return null;
  return Object.fromEntries(names.map((name, i) => [name, values[i]]));
}
const configuredAddress = value => typeof value === 'string' ? value : value?.address;

// Accept maps/arrays of registry entries, including IDs/addresses used as keys.
// Only exact bytes32/address matches count; labels, nulls, and TBDs never match.
function registryMatches(tree, target, path) {
  const found = [];
  function visit(node, here) {
    if (typeof node === 'string') { if (same(node, target)) found.push(here); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (same(key, target) && value !== null && value !== false) found.push(`${here}.${key}`);
      visit(value, `${here}.${key}`);
    }
  }
  visit(tree, path);
  return found;
}

async function main() {
  jsonRequested = process.argv.slice(2).includes('--json');
  const args = parseArgs(process.argv.slice(2));
  if (args['--help']) { console.error(HELP); return; }
  const files = ['addresses.json', 'abis/morpho-core.json', 'abis/adaptive-curve-irm.json',
    'abis/ioracle.json', 'abis/erc20.json', 'abis/farm-chainlink-feed.json'];
  const loaded = await Promise.all(files.map(async path => {
    const text = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    return { path, hash: createHash('sha256').update(text).digest('hex'), data: JSON.parse(text) };
  }));
  const [book, coreAbi, irmAbi, oracleAbi, tokenAbi, feedAbi] = loaded.map((f, i) => i === 0 ? f.data : f.data.abi ?? f.data);
  const core = configuredAddress(book.morpho?.core);
  const expectedOwner = configuredAddress(book.morpho?.coreOwner);
  const adaptiveIrm = configuredAddress(book.morpho?.adaptiveCurveIrm);
  const oracleFactory = configuredAddress(book.morpho?.chainlinkOracleV2Factory);
  if (![core, expectedOwner, adaptiveIrm, oracleFactory].every(nonzeroAddress)) throw new ReaderError('Required Morpho address-book entries are invalid');
  const expectedChainId = BigInt(book.chain?.id ?? book.chain?.chainId ?? 4663);
  const marketId = args['--market'].toLowerCase();
  const account = args['--account']?.toLowerCase();
  const client = createPublicClient({ transport: http(RPC_URL, { retryCount: 0, timeout: 20_000 }) });
  const chainId = BigInt(await client.getChainId());
  if (chainId !== expectedChainId) throw new ReaderError('RPC chain ID differs from the address book');
  const block = await client.getBlock(args['--block'] === undefined ? { blockTag: 'latest' } : { blockNumber: BigInt(args['--block']) });
  if (block.number === null || !idPattern.test(block.hash ?? '') || (args['--block'] !== undefined && block.number !== BigInt(args['--block']))) {
    throw new ReaderError('RPC did not return the requested mined block');
  }
  pinned = { chainId, blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp };
  const provenance = source => ({ ...pinned, source });
  const reads = [], checks = [], failures = [], warnings = [];
  const staticSources = loaded.map(({ path, hash }) => ({ path, sha256: hash }));

  async function read(address, abi, functionName, callArgs = [], optional = false, abiSource = null) {
    const entry = abi.find(f => f.type === 'function' && f.name === functionName);
    const record = { address, function: functionName, args: callArgs, optional,
      abiSource, provenance: provenance('eth_call'), status: 'failed', value: null };
    reads.push(record);
    if (!entry || !['view', 'pure'].includes(entry.stateMutability)) {
      record.error = 'Read-only getter missing from local ABI';
    } else {
      try {
        const result = await client.readContract({ address, abi: [entry], functionName, args: callArgs, blockNumber: block.number });
        if (result === undefined || result === null) throw new Error();
        record.value = entry.outputs.length > 1 && entry.outputs.every(o => o.name)
          ? struct(result, entry.outputs.map(o => o.name)) : result;
        if (record.value === null) throw new Error();
        record.status = 'ok';
        return record.value;
      } catch { record.error = 'eth_call failed or response could not be decoded'; }
    }
    if (!optional) failures.push(`${functionName} at ${address}: read unavailable`);
    return null;
  }
  async function rpcRead(method, address, slot) {
    const record = { address, method, ...(slot ? { slot } : {}), status: 'failed', value: null,
      provenance: provenance(method) };
    reads.push(record);
    try {
      const value = method === 'eth_getCode' ? await client.getCode({ address, blockNumber: block.number })
        : await client.getStorageAt({ address, slot, blockNumber: block.number });
      // A missing RPC storage response is not evidence of an empty slot.
      if (typeof value !== 'string' || (slot ? !idPattern.test(value) : !/^0x(?:[a-fA-F0-9]{2})*$/.test(value))) throw new Error();
      record.value = value;
      record.status = 'ok';
      return value;
    } catch {
      record.error = 'Pinned RPC read failed or malformed response';
      failures.push(`${method} at ${address}: read unavailable`);
      return null;
    }
  }
  function check(name, pass, actual, expected, source, note = null) {
    checks.push({ name, status: pass ? 'pass' : 'fail', actual, expected, note, provenance: provenance(source) });
  }
  const coreRead = (name, values = []) => read(core, coreAbi, name, values, false, 'abis/morpho-core.json');
  const [paramsRaw, marketRaw, owner, code, implementationSlot, coreBeaconSlot] = await Promise.all([
    coreRead('idToMarketParams', [marketId]), coreRead('market', [marketId]), coreRead('owner'),
    rpcRead('eth_getCode', core), rpcRead('eth_getStorageAt', core, IMPLEMENTATION_SLOT),
    rpcRead('eth_getStorageAt', core, BEACON_SLOT),
  ]);
  const params = struct(paramsRaw, PARAM_NAMES), market = struct(marketRaw, MARKET_NAMES);
  if (!params || !market) throw new ReaderError('Market params/totals unavailable or incompatible with documented structs');
  if (![params.loanToken, params.collateralToken, params.oracle].every(nonzeroAddress)
    || !validAddress(params.irm) || market.lastUpdate === 0n) throw new ReaderError('Market is absent or has invalid required addresses');
  const computedId = keccak256(encodeAbiParameters(PARAM_TYPES, PARAM_NAMES.map(n => params[n])));
  check('marketId', same(computedId, marketId), computedId, marketId, 'keccak256(abi.encode(idToMarketParams(id)))');
  const hasCode = code !== null && code !== '0x' && /[1-9a-f]/i.test(code.slice(2));
  const minimalProxy = code === null ? null : /^0x363d3d373d3d3d363d73[0-9a-f]{40}5af43d82803e903d91602b57fd5bf3/i.test(code);
  check('coreRuntimeBytecode', hasCode && !minimalProxy,
    { bytecode: code, bytes: code === null ? null : (code.length - 2) / 2, codeHash: code === null ? null : keccak256(code), eip1167Pattern: minimalProxy },
    'Nonempty runtime, not the standard EIP-1167 minimal proxy', 'eth_getCode');
  check('coreImplementationSlot', implementationSlot !== null && same(implementationSlot, ZERO_SLOT),
    { slot: IMPLEMENTATION_SLOT, value: implementationSlot }, ZERO_SLOT, 'eth_getStorageAt');
  check('coreBeaconSlot', coreBeaconSlot !== null && same(coreBeaconSlot, ZERO_SLOT),
    { slot: BEACON_SLOT, value: coreBeaconSlot }, ZERO_SLOT, 'eth_getStorageAt');
  check('coreOwner', same(owner, expectedOwner), owner, expectedOwner, 'core.owner()');
  const powers = ['enableIrm', 'enableLltv', 'setFee', 'setFeeRecipient', 'setOwner'];
  check('ownerNonCustodialPowers', false,
    { owner, runtimeCodeHash: code === null ? null : keccak256(code),
      documentedPowers: powers, documentedMaxFeeWad: WAD / 4n,
      powersPresentInLocalAbi: powers.filter(name => coreAbi.some(f => f.type === 'function' && f.name === name)),
      deployedRestrictionsVerified: false },
    'Only the enumerated powers, fee cap 25%, no pause/seize/upgrade/market-param mutation or other admin',
    'VERIFY.md §1 and AGENT-GUIDE.md §1; owner and bytecode reads',
    'UNVERIFIED: ABI and empty standard proxy slots cannot prove absence of extra powers. Audited core source/runtime reference is not bundled; no bytecode identity proof performed.');

  const [irmEnabled, irmMorpho, lltvEnabled, loanDecimals, collateralDecimals, price, beaconSlot, rate, rateAtTarget, positionRaw] = await Promise.all([
    coreRead('isIrmEnabled', [params.irm]), read(params.irm, irmAbi, 'MORPHO', [], false, 'abis/adaptive-curve-irm.json'),
    coreRead('isLltvEnabled', [params.lltv]),
    read(params.loanToken, tokenAbi, 'decimals', [], false, 'abis/erc20.json'),
    read(params.collateralToken, tokenAbi, 'decimals', [], false, 'abis/erc20.json'),
    read(params.oracle, oracleAbi, 'price', [], false, 'abis/ioracle.json'),
    rpcRead('eth_getStorageAt', params.collateralToken, BEACON_SLOT),
    read(params.irm, irmAbi, 'borrowRateView', [params, market], false, 'abis/adaptive-curve-irm.json'),
    read(params.irm, irmAbi, 'rateAtTarget', [marketId], false, 'abis/adaptive-curve-irm.json'),
    account ? coreRead('position', [marketId, account]) : Promise.resolve(null),
  ]);
  check('canonicalAdaptiveIrm', same(params.irm, adaptiveIrm), params.irm, adaptiveIrm, 'core.idToMarketParams(id).irm + addresses.json');
  check('irmEnabled', irmEnabled === true, { irm: params.irm, enabled: irmEnabled }, true, 'core.isIrmEnabled(irm)');
  check('irmMorpho', same(irmMorpho, core), irmMorpho, core, 'irm.MORPHO()');
  check('lltvEnabled', lltvEnabled === true, { lltv: params.lltv, enabled: lltvEnabled }, true, 'core.isLltvEnabled(lltv)');
  check('marketFeeCap', market.fee <= WAD / 4n, market.fee, { maximumWad: WAD / 4n }, 'core.market(id).fee',
    'Checks this market fee, not whether deployed code enforces the cap on future governance calls.');
  const marketMatches = registryMatches(book.solon?.markets, marketId, 'solon.markets');
  const oracleMatches = registryMatches(book.solon?.oracleAdapters, params.oracle, 'solon.oracleAdapters');
  const beacon = beaconSlot !== null && /^0x0{24}[0-9a-fA-F]{40}$/.test(beaconSlot) ? `0x${beaconSlot.slice(-40)}` : null;
  const tier = marketMatches.length && oracleMatches.length ? 'SOLON CERTIFIED'
    : same(beacon, TOKEN_BEACON) ? 'ISSUER-VERIFIED' : 'UNCERTIFIED';
  // Oracle provenance is tier-dependent. For a SOLON CERTIFIED market the oracle IS Solon's own
  // listed adapter (VERIFY.md's factory check is for third-party markets, not tier 1), so the
  // adapter registry match establishes provenance — do not cry wolf with a factory FAIL here.
  // For non-certified markets, provenance is genuinely unverified (no factory getter in the ABIs).
  const oracleProvenanceOk = tier === 'SOLON CERTIFIED' && oracleMatches.length > 0;
  check('oracleProvenance', oracleProvenanceOk,
    { oracle: params.oracle, tier, solonAdapterMatch: oracleMatches, configuredFactory: oracleFactory },
    'Oracle provenance established (tier-1 Solon adapter, or a canonical-factory attestation)',
    'SKILL.md tiers + addresses.json solon.oracleAdapters',
    oracleProvenanceOk ? null
      : 'UNVERIFIED for non-certified markets: the oracle is not a listed Solon adapter and no factory-membership getter is in the supplied ABIs — confirm the feed source yourself before trusting the price.');
  const classification = { tier, marketMatches, oracleMatches, collateralBeaconSlot: { slot: BEACON_SLOT, value: beaconSlot },
    collateralBeacon: beacon, expectedIssuerBeacon: TOKEN_BEACON,
    issuerCheckAvailable: beaconSlot !== null,
    provenance: provenance('SKILL.md tiers; local addresses.json registry + eth_getStorageAt(collateral, EIP-1967 beacon slot)'),
    note: 'Certification is a registry/slot classification, separate from verification checks. An unreadable beacon is never issuer verification.' };

  let scale = null;
  if (loanDecimals !== null && collateralDecimals !== null) {
    try { scale = deriveOracleScale(BigInt(loanDecimals), BigInt(collateralDecimals)); }
    catch { failures.push('Oracle decimal scale could not be derived'); }
  }
  const roundProbes = await Promise.all([
    read(params.oracle, feedAbi, 'latestRoundData', [], true, 'abis/farm-chainlink-feed.json (optional oracle probe)'),
    read(params.oracle, ADAPTER_ABI, 'STOCK_FEED', [], true, 'adapter/StockOracleAdapter.sol'),
    read(params.oracle, ADAPTER_ABI, 'USDG_FEED', [], true, 'adapter/StockOracleAdapter.sol'),
  ]);
  const [directRound, stockFeed, usdgFeed] = roundProbes;
  const adapterDetected = nonzeroAddress(stockFeed) || nonzeroAddress(usdgFeed);
  const maxStaleness = adapterDetected ? await read(params.oracle, ADAPTER_ABI, 'MAX_STALENESS', [], true, 'adapter/StockOracleAdapter.sol') : null;
  const feeds = [];
  if (directRound !== null) feeds.push({ role: 'oracle', address: params.oracle, round: directRound, maxStaleness: null });
  for (const [role, address] of [['stock', stockFeed], ['usdg', usdgFeed]]) {
    if (!nonzeroAddress(address)) continue;
    const round = await read(address, feedAbi, 'latestRoundData', [], true, 'abis/farm-chainlink-feed.json');
    feeds.push({ role, address, round, maxStaleness });
  }
  for (const f of feeds) {
    f.provenance = provenance('feed.latestRoundData()');
    const r = f.round;
    f.roundValid = r !== null && r.roundId > 0n && r.answer > 0n && r.updatedAt > 0n
      && r.updatedAt <= block.timestamp && r.answeredInRound >= r.roundId;
    f.ageSeconds = r && r.updatedAt <= block.timestamp ? block.timestamp - r.updatedAt : null;
    f.withinStalenessBound = f.maxStaleness === null || f.ageSeconds === null ? null : f.ageSeconds <= f.maxStaleness;
    if (!f.roundValid || f.withinStalenessBound === false) failures.push(`${f.role} oracle feed failed round/freshness validation`);
  }
  if (adapterDetected && (!nonzeroAddress(stockFeed) || !nonzeroAddress(usdgFeed) || maxStaleness === null)) {
    failures.push('Partially detected stock adapter: feed wiring/staleness bound unavailable');
  }
  const feedValid = feeds.every(f => f.roundValid && f.withinStalenessBound !== false)
    && (!adapterDetected || (nonzeroAddress(stockFeed) && nonzeroAddress(usdgFeed) && maxStaleness !== null));
  const priceValid = typeof price === 'bigint' && price > 0n && scale !== null && feedValid;
  check('oraclePrice', priceValid, { price, loanDecimals, collateralDecimals, scale, feedValid },
    'Successful positive price, derived decimal scale, valid exposed rounds', 'oracle.price(), token.decimals(), exposed feed rounds',
    'No independent market-price range supplied. Positive is not proof of economic accuracy; opaque oracle freshness is not independently verified.');
  if (!priceValid) failures.push('Oracle invalid/unavailable: price and borrower health suppressed (APY is oracle-independent and still reported)');
  if (!feeds.length) warnings.push('Oracle is opaque: latestRoundData and known stock-adapter feed getters unavailable; freshness cannot be independently established.');
  else if (feeds.some(f => f.maxStaleness === null)) warnings.push('Round timestamps exposed, but no confirmed staleness policy for these feeds.');

  let utilizationWad = null, borrowApyWad = null, supplyApyWad = null;
  try { utilizationWad = utilization(market.totalBorrowAssets, market.totalSupplyAssets); }
  catch { failures.push('Invalid market utilization inputs'); }
  const rateValid = typeof rate === 'bigint' && rate >= 0n && same(params.irm, adaptiveIrm)
    && irmEnabled === true && same(irmMorpho, core) && rateAtTarget !== null;
  // APY is a function of the IRM rate + utilization + fee only. It does NOT depend on the
  // collateral oracle, so it is reported even when the oracle price is stale/opaque; the
  // oracle only gates the price and the borrower health, not the interest rate.
  if (rateValid && utilizationWad !== null && same(computedId, marketId)) {
    try {
      borrowApyWad = apyFromRate(rate);
      supplyApyWad = supplyApy(borrowApyWad, utilizationWad, market.fee);
    } catch { borrowApyWad = null; supplyApyWad = null; failures.push('APY inputs/result outside supported integer bounds'); }
  }
  const lag = block.timestamp >= market.lastUpdate ? block.timestamp - market.lastUpdate : null;
  if (lag === null) { failures.push('Market lastUpdate is later than the pinned block'); borrowApyWad = null; supplyApyWad = null; }
  warnings.push('market() totals are stored checkpoints. No pending interest or fee-share accrual is simulated; health is not a current liquidation verdict.');
  let position = null;
  if (account) {
    const rawPosition = struct(positionRaw, POSITION_NAMES);
    if (!rawPosition) failures.push('Position struct unavailable');
    else {
      const supplyAssets = sharesToAssets(rawPosition.supplyShares, market.totalSupplyAssets, market.totalSupplyShares);
      const borrowAssets = sharesToAssets(rawPosition.borrowShares, market.totalBorrowAssets, market.totalBorrowShares, 'up');
      let health = null;
      if (priceValid && same(computedId, marketId) && lag !== null) {
        try { health = lendingHealth({ collateral: rawPosition.collateral, price, lltv: params.lltv, debt: borrowAssets }); }
        catch { failures.push('Health inputs rejected'); }
      }
      position = { account, ...rawPosition, supplyAssets, borrowAssets, health,
        basis: 'STORED_CHECKPOINT_TOTALS_WITH_PINNED_ORACLE_PRICE', pendingInterestIncluded: false,
        currentLiquidationVerdict: null,
        formula: 'borrowAssets=ceil(borrowShares*(totalBorrowAssets+1)/(totalBorrowShares+1e6)); value=floor(collateral*price/1e36); maxBorrow=floor(value*lltv/1e18); health=maxBorrow/debt; liquidatable iff debt>maxBorrow',
        liquidationBoundary: 'health.minHealthyOraclePrice is the minimum integer oracle price covering frozen checkpoint debt after both floors; lower prices are liquidatable on that basis',
        provenance: provenance('core.position(id,account), core.market(id), oracle.price(); AGENT-GUIDE.md §§1,3') };
    }
  }
  const finalBlock = await client.getBlock({ blockNumber: block.number });
  if (finalBlock.hash !== block.hash || finalBlock.number !== block.number) throw new ReaderError('Pinned block changed during reads; discard snapshot and retry');
  const verificationPassed = checks.every(c => c.status === 'pass');
  const snapshot = {
    schema: 'solon-market/v1', provenance: provenance('Pinned number reads with final canonical hash recheck; RPC consistency assumed'),
    provenanceScope: 'All chain values, calculations, checks, and registry comparisons in this snapshot inherit this block/hash. Local configuration is a SHA-256-tagged reference, not an on-chain read.',
    block: { number: block.number, hash: block.hash, timestamp: block.timestamp }, chainId, marketId, core,
    status: failures.length ? 'UNRELIABLE_READ' : verificationPassed ? 'VERIFIED' : 'READ_WITH_UNVERIFIED_CHECKS',
    staticSources, marketParams: params, market, owner, checkpointAgeSeconds: lag,
    checks, verificationPassed, classification,
    oracle: { address: params.oracle, status: priceValid ? 'PRICE_READ' : 'INVALID', price: priceValid ? price : null,
      rawPriceRead: price, loanDecimals, collateralDecimals, scale, scaleFormula: '10^(36 + loanDecimals - collateralDecimals)',
      baseUnitValuationDivisor: 10n ** 36n, feeds, opaque: feeds.length === 0,
      provenance: provenance('oracle.price(), ERC20 decimals, optional Chainlink/stock-adapter probes') },
    rates: { borrowRatePerSecondWad: rate, rateAtTargetWadPerSecond: rateAtTarget, utilizationWad, borrowApyWad, supplyApyWad,
      secondsPerYear: SECONDS_PER_YEAR, fixedPointScale: WAD,
      convention: '(1 + ratePerSecond/WAD)^31536000 - 1; frozen borrowRateView; exponentiation by squaring with floor after each WAD multiply; supplyAPY=floor(floor(borrowAPY*utilization/WAD)*(WAD-fee)/WAD)',
      basis: 'Stored market totals and pinned-time borrowRateView. Display APY is not Morpho Taylor accrual or a yield forecast.',
      provenance: provenance('irm.borrowRateView(marketParams,market), irm.rateAtTarget(id), core.market(id); market-math.mjs') },
    position, warnings, failures, reads,
  };
  const pct = value => value === null ? 'unavailable' : `${formatUnits(value * 100n, 18)}%`;
  const summary = [
    `Solon market ${marketId} | chain ${chainId} | block ${block.number} (${block.hash})`,
    `${classification.tier} | ${snapshot.status}`,
    `Loan ${params.loanToken} | collateral ${params.collateralToken}`,
    `Utilization ${pct(utilizationWad)} | borrow APY ${pct(borrowApyWad)} | supply APY ${pct(supplyApyWad)}`,
    `Oracle ${params.oracle} | raw price ${priceValid ? price : 'unavailable'} | scale 10^${scale?.exponent ?? '?'} | ${feeds.length ? 'rounds exposed' : 'opaque'}`,
    ...feeds.map(f => `Feed ${f.role} ${f.address} | round ${f.round?.roundId ?? '?'} | updatedAt ${f.round?.updatedAt ?? '?'} | valid ${f.roundValid}`),
    ...(position ? [`Account ${account} | supply ${position.supplyAssets} | borrow ${position.borrowAssets} | collateral ${position.collateral} (base units; checkpoint assets)`,
      `Checkpoint health ${position.health === null ? 'unavailable' : position.health.debtFree ? 'debt-free' : formatUnits(position.health.healthFactorWad, 18)} | current liquidation verdict unavailable (pending interest excluded)`] : []),
    ...checks.map(c => {
      // Keep the complete bytecode in JSON/read provenance, not a 30KB human line.
      const actual = c.name === 'coreRuntimeBytecode'
        ? { bytes: c.actual.bytes, codeHash: c.actual.codeHash, eip1167Pattern: c.actual.eip1167Pattern } : c.actual;
      return `${c.status.toUpperCase()} ${c.name}: ${json(actual).replace(/\n\s*/g, ' ')}${c.note ? ` | ${c.note}` : ''}`;
    }),
    ...warnings.map(w => `Note: ${w}`), ...failures.map(f => `UNRELIABLE: ${f}`),
  ].join('\n');
  // Never serialize the client/transport, argv, raw exceptions, or address-book RPC.
  console.error(redact(summary));
  if (args['--json']) console.log(redact(json(snapshot)));
  if (failures.length || !verificationPassed) process.exitCode = 2;
}

main().catch(error => {
  // Provider exceptions may echo URL credentials, headers, or entire requests.
  // Only our fixed, input-free ReaderError messages may leave this process.
  const reason = error instanceof ReaderError ? error.message : 'Required local input or pinned RPC read failed';
  console.error(redact(`Market read failed; no reliable snapshot produced. ${reason}\n${HELP}`));
  if (jsonRequested) console.log(redact(json({ schema: 'solon-market/v1', status: 'FAILED', provenance: pinned, error: reason })));
  process.exitCode = 1;
});
