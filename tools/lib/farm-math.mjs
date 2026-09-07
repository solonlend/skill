// SPDX-License-Identifier: GPL-2.0-or-later
// Reference port of leverage/src/libraries/{TickMath,LiquidityAmounts,FairLpMath}.sol
// and LpShareOracleV4.sol. No dependencies, RPC, clocks, or floating-point quantities.
export const WAD = 10n ** 18n;
export const PRICE_SCALE = 10n ** 36n;
const BPS = 10000n;
const Q96 = 1n << 96n;
const Q192 = Q96 * Q96;
const UINT256_MAX = (1n << 256n) - 1n;
const INT256_MAX = (1n << 255n) - 1n;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
function integer(x, name) {
  if (typeof x === 'number' && !Number.isSafeInteger(x)) throw new RangeError(`${name}: unsafe integer`);
  if (!['bigint', 'number', 'string'].includes(typeof x)) throw new TypeError(`${name}: integer required`);
  return BigInt(x);
}
function nonnegative(x, name) {
  x = integer(x, name);
  if (x < 0n) throw new RangeError(`${name}: negative`);
  return x;
}
function pow10(decimals) {
  const d = nonnegative(decimals, 'decimals');
  if (d > 77n) throw new RangeError('decimals exceed uint256 exponent range');
  return 10n ** d;
}
function ceilDiv(a, b) { return a / b + (a % b === 0n ? 0n : 1n); }
/** healthBps = floor(D*1e18*10000/(V*lltv)), BEFORE capacity flooring.
 * null healthBps + note='infinite' represents infinity; null + 'inactive' is V=D=0.
 * Inactive returns isHealthy=null, rather than suggesting an active healthy receipt.
 */
export function healthUtilization(D, V, lltv) {
  D = nonnegative(D, 'D'); V = nonnegative(V, 'V'); lltv = nonnegative(lltv, 'lltv');
  if (lltv > WAD) throw new RangeError('lltv exceeds 1e18');
  const numerator = V * lltv;
  const capacity = numerator / WAD;
  const inactive = V === 0n && D === 0n;
  return { healthBps: numerator === 0n ? (D === 0n && !inactive ? 0n : null) : D * WAD * BPS / numerator,
    capacity, headroom: capacity - D, isHealthy: inactive ? null : capacity >= D,
    note: inactive ? 'inactive' : numerator === 0n && D > 0n ? 'infinite' : 'utilization; lower is safer' };
}
function slippageArgs(expected, sBps) {
  expected = nonnegative(expected, 'expected'); sBps = nonnegative(sBps, 'sBps');
  if (sBps > BPS) throw new RangeError('sBps exceeds 10000');
  return [expected, sBps];
}
export function slippageFloor(expected, sBps) {
  [expected, sBps] = slippageArgs(expected, sBps);
  return expected * (BPS - sBps) / BPS;
}
export function slippageCeil(expected, sBps) {
  [expected, sBps] = slippageArgs(expected, sBps);
  return ceilDiv(expected * (BPS + sBps), BPS);
}
export function evalFeed({answer, updatedAt, roundId, answeredInRound, now, maxStaleness}) {
  answer = integer(answer, 'answer'); updatedAt = nonnegative(updatedAt, 'updatedAt');
  roundId = nonnegative(roundId, 'roundId'); answeredInRound = nonnegative(answeredInRound, 'answeredInRound');
  now = nonnegative(now, 'now'); maxStaleness = nonnegative(maxStaleness, 'maxStaleness');
  const ageSeconds = now - updatedAt;
  const reason = roundId === 0n || updatedAt === 0n || answeredInRound < roundId ? 'bad round'
    : ageSeconds < 0n ? 'future timestamp' : ageSeconds > maxStaleness ? 'stale'
    : answer <= 0n ? 'nonpositive answer' : null;
  return {fresh:reason === null, ageSeconds, failClosed:reason !== null, reason};
}
/** usdgPrice is a native answer with feedDecimals (default 18), NOT a float. */
export function evalDepeg({usdgPrice, depegBps, feedDecimals = 18n}) {
  usdgPrice = integer(usdgPrice, 'usdgPrice'); depegBps = nonnegative(depegBps, 'depegBps');
  if (depegBps > BPS) throw new RangeError('depegBps exceeds 10000');
  const peg = pow10(feedDecimals);
  const delta = usdgPrice > peg ? usdgPrice - peg : peg - usdgPrice;
  return {inBand:usdgPrice > 0n && usdgPrice >= peg * (BPS - depegBps) / BPS && usdgPrice <= peg * (BPS + depegBps) / BPS,
    deviationBps:delta * BPS / peg};
}
const TICK_MULTIPLIERS = [
  0xfffcb933bd6fad37aa2d162d1a594001n, 0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n, 0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n, 0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n,
];
export function getSqrtRatioAtTick(tick) {
  tick = integer(tick, 'tick');
  let abs = tick < 0n ? -tick : tick;
  if (abs > 887272n) throw new RangeError('tick out of range');
  let ratio = 1n << 128n;
  for (const multiplier of TICK_MULTIPLIERS) {
    if ((abs & 1n) !== 0n) ratio = ratio * multiplier >> 128n;
    abs >>= 1n;
  }
  if (tick > 0n) ratio = UINT256_MAX / ratio;
  return ceilDiv(ratio, 1n << 32n);
}
/** Display P in human LOAN/RISK units, floored at 36 decimals.
 * Uses the source TickMath rounded Q96 sqrt, squared (not Math.pow).
 * Tiny values may display zero; exact source sqrt remains available separately.
 */
export function tickToPrice(tick, dec0, dec1, riskIsToken0) {
  if (typeof riskIsToken0 !== 'boolean') throw new TypeError('riskIsToken0 must be boolean');
  const sqrt = getSqrtRatioAtTick(tick);
  const num = sqrt * sqrt * pow10(dec0);
  const den = Q192 * pow10(dec1);
  return {mantissa:riskIsToken0 ? num * PRICE_SCALE / den : den * PRICE_SCALE / num, scale:PRICE_SCALE};
}
export function amountsForLiquidity(liquidity, sqrtP, sqrtA, sqrtB) {
  liquidity = nonnegative(liquidity, 'liquidity');
  if (liquidity >= (1n << 128n)) throw new RangeError('liquidity exceeds uint128');
  sqrtP = nonnegative(sqrtP, 'sqrtP'); sqrtA = nonnegative(sqrtA, 'sqrtA'); sqrtB = nonnegative(sqrtB, 'sqrtB');
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA === 0n) throw new RangeError('sqrtA is zero');
  const amount0 = (a,b) => ((liquidity << 96n) * (b-a) / b) / a;
  const amount1 = (a,b) => liquidity * (b-a) / Q96;
  if (sqrtP <= sqrtA) return {amount0:amount0(sqrtA,sqrtB),amount1:0n};
  if (sqrtP < sqrtB) return {amount0:amount0(sqrtP,sqrtB),amount1:amount1(sqrtA,sqrtP)};
  return {amount0:0n,amount1:amount1(sqrtA,sqrtB)};
}
function isqrt(n) {
  if (n < 0n) throw new RangeError('negative square root');
  if (n < 2n) return n;
  let x = 1n << ((BigInt(n.toString(2).length) + 1n) / 2n);
  for (;;) {
    const next = (x + n / x) >> 1n;
    if (next >= x) return x;
    x = next;
  }
}
function uint256(n, label) {
  if (n < 0n || n > UINT256_MAX) throw new RangeError(`${label}: uint256 overflow`);
  return n;
}
/** BigInt can materialize the 320-bit rational; both Solidity branches yield this exact sqrt. */
export function sqrtPriceX96FromFeeds(price0, price1, dec0, dec1) {
  price0 = nonnegative(price0, 'price0'); price1 = nonnegative(price1, 'price1');
  if (price0 === 0n || price1 === 0n) throw new RangeError('positive feed prices required');
  const num = uint256(price0 * pow10(dec1), 'feed numerator');
  const den = uint256(price1 * pow10(dec0), 'feed denominator');
  const sqrt = isqrt(num * Q192 / den);
  if (sqrt < MIN_SQRT_RATIO || sqrt >= MAX_SQRT_RATIO) throw new RangeError('SQRT_RANGE');
  return sqrt;
}
function positionConfig(args) {
  const liquidity = nonnegative(args.liquidity,'liquidity');
  if (liquidity >= (1n << 128n)) throw new RangeError('liquidity exceeds uint128');
  const tickLower = integer(args.tickLower,'tickLower'), tickUpper = integer(args.tickUpper,'tickUpper');
  if (tickLower >= tickUpper) throw new RangeError('tickLower must be below tickUpper');
  const sqrtA = getSqrtRatioAtTick(tickLower), sqrtB = getSqrtRatioAtTick(tickUpper);
  const dec0 = nonnegative(args.dec0,'dec0'), dec1 = nonnegative(args.dec1,'dec1');
  const scale0 = pow10(dec0), scale1 = pow10(dec1);
  const riskIsToken0 = args.riskIsToken0;
  if (typeof riskIsToken0 !== 'boolean') throw new TypeError('riskIsToken0 must be boolean');
  const riskScale = riskIsToken0 ? scale0 : scale1, loanScale = riskIsToken0 ? scale1 : scale0;
  const loanPrice = nonnegative(args.loanPrice,'loanPrice');
  if (loanPrice === 0n) throw new RangeError('loanPrice must be positive');
  if (loanPrice > INT256_MAX) throw new RangeError('loanPrice exceeds int256 feed answer');
  const dRisk = uint256(nonnegative(args.dRisk ?? 0n,'dRisk'),'dRisk');
  const dLoan = uint256(nonnegative(args.dLoan ?? 0n,'dLoan'),'dLoan');
  const lltv = nonnegative(args.lltv,'lltv');
  if (lltv > WAD) throw new RangeError('lltv exceeds 1e18');
  return {liquidity,tickLower,tickUpper,sqrtA,sqrtB,dec0,dec1,scale0,scale1,riskIsToken0,riskScale,loanScale,loanPrice,dRisk,dLoan,lltv};
}
function valueAt(c, riskPrice) {
  riskPrice = nonnegative(riskPrice,'riskPrice');
  if (riskPrice > INT256_MAX) throw new RangeError('riskPrice exceeds int256 feed answer');
  const price0 = c.riskIsToken0 ? riskPrice : c.loanPrice;
  const price1 = c.riskIsToken0 ? c.loanPrice : riskPrice;
  const sqrtPriceX96 = sqrtPriceX96FromFeeds(price0,price1,c.dec0,c.dec1);
  const {amount0,amount1} = amountsForLiquidity(c.liquidity,sqrtPriceX96,c.sqrtA,c.sqrtB);
  const valueUsd = uint256(uint256(amount0*price0,'amount0*price0')/c.scale0 + uint256(amount1*price1,'amount1*price1')/c.scale1,'valueUsd');
  const valueInLoan = uint256(valueUsd*c.loanScale/c.loanPrice,'valueInLoan');
  const riskValue = c.dRisk === 0n ? 0n : uint256(c.dRisk * uint256(riskPrice*c.loanScale,'risk price scale') / uint256(c.loanPrice*c.riskScale,'loan price scale'),'riskValue');
  const debtInLoan = uint256(c.dLoan+riskValue,'debtInLoan');
  const capacity = uint256(valueInLoan*c.lltv,'capacity product')/WAD;
  return {riskPrice, price:{mantissa:riskPrice*PRICE_SCALE/c.loanPrice,scale:PRICE_SCALE},sqrtPriceX96,amount0,amount1,
    valueInLoan,debtInLoan,capacity,headroom:capacity-debtInLoan,isHealthy:capacity>=debtInLoan};
}
/** All input prices are positive native feed answers sharing the same feed decimals.
 * Implements LpShareOracleV4 valuation plus dual debt conversion; single passes dRisk=0.
 * Assumes LOAN is the other pool token; caller must verify wiring/feed-decimal equality.
 * Protocol integer overflow and SQRT_RANGE errors are not turned into valuations.
 */
export function fairPositionAtRiskPrice(args) { return valueAt(positionConfig(args),args.riskPrice); }
function searchDomain(c,args) {
  // s_min^2 <= ratio*Q192 < s_max^2, exactly; all candidates are integer feed answers.
  const n = c.loanPrice*c.riskScale;
  const d = Q192*c.loanScale;
  let min, max;
  if (c.riskIsToken0) {
    min = ceilDiv(MIN_SQRT_RATIO**2n*n,d);
    max = ceilDiv(MAX_SQRT_RATIO**2n*n,d)-1n;
  } else {
    const numerator = c.loanPrice*c.riskScale*Q192;
    min = numerator/(MAX_SQRT_RATIO**2n*c.loanScale)+1n;
    max = numerator/(MIN_SQRT_RATIO**2n*c.loanScale);
  }
  if (min < 1n) min = 1n;
  const arithmeticMax = UINT256_MAX/c.loanScale;
  if (max > arithmeticMax) max = arithmeticMax;
  if (max > INT256_MAX) max = INT256_MAX;
  if (args.minRiskPrice !== undefined) {
    const requested = nonnegative(args.minRiskPrice,'minRiskPrice');
    if (requested > min) min = requested;
  }
  if (args.maxRiskPrice !== undefined) {
    const requested = nonnegative(args.maxRiskPrice,'maxRiskPrice');
    if (requested < max) max = requested;
  }
  if (min > max) throw new RangeError('empty candidate price domain');
  return {min,max};
}
function intervalHealth(c,a,b) {
  // RISK amount decreases and LOAN amount increases with the RISK price, for either token ordering.
  // Bounding each nonnegative product separately certifies ALL integer prices in [a,b].
  // No assumption of monotonic rounded V/headroom (rounding can create tiny healthy islands).
  const riskA = c.riskIsToken0 ? a.amount0 : a.amount1;
  const riskB = c.riskIsToken0 ? b.amount0 : b.amount1;
  const loanA = c.riskIsToken0 ? a.amount1 : a.amount0;
  const loanB = c.riskIsToken0 ? b.amount1 : b.amount0;
  const minUsd = riskB*a.riskPrice/c.riskScale + loanA*c.loanPrice/c.loanScale;
  const maxRiskProduct = riskA*b.riskPrice, maxLoanProduct = loanB*c.loanPrice;
  const maxUsd = maxRiskProduct/c.riskScale + maxLoanProduct/c.loanScale;
  const maxLoanValue = maxUsd*c.loanScale/c.loanPrice;
  // A health certificate is invalid if an intermediate Solidity multiplication could revert
  // inside the interval, even when both endpoints are valid. Subdivide until proven safe
  // or valueAt exposes the exact source overflow (never skip an oracle-revert island).
  if (maxRiskProduct > UINT256_MAX || maxLoanProduct > UINT256_MAX || maxUsd > UINT256_MAX
      || maxLoanValue > UINT256_MAX || maxLoanValue*c.lltv > UINT256_MAX) return null;
  const minCapacity = (minUsd*c.loanScale/c.loanPrice)*c.lltv/WAD;
  const maxCapacity = maxLoanValue*c.lltv/WAD;
  if (minCapacity >= b.debtInLoan) return true;
  if (maxCapacity < a.debtInLoan) return false;
  return null;
}
function boundaries(args) {
  const c = positionConfig(args), domain = searchDomain(c,args);
  const current = nonnegative(args.currentRiskPrice,'currentRiskPrice');
  if (current < domain.min || current > domain.max) throw new RangeError('currentRiskPrice outside search domain');
  const budget = nonnegative(args.maxEvaluations ?? 100000n,'maxEvaluations');
  const cache = new Map();
  let evaluations = 0n;
  const at = p => {
    if (!cache.has(p)) {
      if (++evaluations > budget) throw new RangeError('SEARCH_LIMIT: integer intervals remain uncertified; no absence-of-root claim');
      cache.set(p,valueAt(c,p));
    }
    return cache.get(p);
  };
  const center = at(current);
  const makeRoot = (a,b,direction) => ({
    direction, riskPrice:(a.isHealthy ? b : a).riskPrice,
    price:(a.isHealthy ? b : a).price,
    bracket:{lower:a,upper:b},healthy:a.isHealthy ? a : b,unhealthy:a.isHealthy ? b : a,
    searchDomain:{minRiskPrice:domain.min,maxRiskPrice:domain.max},
    note:'Adjacent native risk-feed answers; equality is healthy. Frozen loan feed, liquidity and debt. Price reports the unhealthy side.',
  });
  const scan = (a,b,direction) => {
    if (a.riskPrice === b.riskPrice) return null;
    if (b.riskPrice-a.riskPrice === 1n) return a.isHealthy === b.isHealthy ? null : makeRoot(a,b,direction);
    const certified = intervalHealth(c,a,b);
    if (certified !== null) return null;
    const mid = at((a.riskPrice+b.riskPrice)/2n);
    return direction === 'lower'
      ? scan(mid,b,direction) ?? scan(a,mid,direction)
      : scan(a,mid,direction) ?? scan(mid,b,direction);
  };
  if (c.dRisk === 0n && c.dLoan === 0n) return {lower:null,upper:null};
  // Geometric shells reach the whole TickMath domain and retain a depth-first nearest-first search.
  const side = direction => {
    let near = center;
    for (;;) {
      const p = direction === 'lower' ? (near.riskPrice/2n < domain.min ? domain.min : near.riskPrice/2n)
        : (near.riskPrice*2n > domain.max ? domain.max : near.riskPrice*2n);
      if (p === near.riskPrice) return null;
      const far = at(p);
      const root = direction === 'lower' ? scan(far,near,direction) : scan(near,far,direction);
      if (root) return root;
      near = far;
    }
  };
  return {lower:side('lower'),upper:side('upper')};
}
/** Search DOWN and UP independently for the nearest isHealthy transition, including outside
 * the LP range. Returns null only after certifying that entire side of the candidate domain.
 * Domain: positive integer risk-feed answers producing MIN_SQRT <= sqrt < MAX_SQRT,
 * narrowed by Solidity feed multiplication limits and optional min/maxRiskPrice.
 * Native feed granularity can skip exact equality; adjacent brackets show actual integer truth.
 * Rounded dust may create extra transitions; only the nearest per direction is returned.
 * maxEvaluations defaults to 100000. Work limit or source arithmetic failure THROWS, never null.
 */
export function dualLiquidationBoundaries(args) { return boundaries(args); }
/** Single-asset uses only dLoan (no synthetic risk debt). Returns the lower transition
 * when present, otherwise the upper transition for an already-unhealthy starting price.
 * As with dual, raw-unit dust can create extra transitions; this is one candidate, not
 * a claim of continuous-price uniqueness. No transition in the search domain => null.
 */
export function singleLiquidationBoundary(args) {
  if (nonnegative(args.dRisk ?? 0n,'dRisk') !== 0n) throw new RangeError('single shape has no risk debt');
  const result = boundaries({...args,dRisk:0n});
  return result.lower ?? result.upper;
}
