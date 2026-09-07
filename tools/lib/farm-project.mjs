// SPDX-License-Identifier: GPL-2.0-or-later
// Pure projection of post-op position state for open/increase, reusing farm-math's
// LiquidityAmounts/FairLpMath port. No dependencies, RPC, clocks, or floats.
//
// This projects an ESTIMATE of health after a dual open/increase. It is NOT a
// guarantee: the vault deploys funds at its own exact ratio and any UNUSED invest
// or borrow first repays the same-leg debt, so real net debt <= projected and real
// minted liquidity uses the mined ratio. The authoritative "post-op state is healthy"
// answer comes from a successful on-chain static pre-flight (solon-farm-sim.mjs),
// which reverts UnhealthyOpen/UnhealthyIncrease when it is not. Use this number to
// see ROUGHLY where health lands, and the pre-flight to know whether it reverts.
import {
  getSqrtRatioAtTick, sqrtPriceX96FromFeeds, fairPositionAtRiskPrice,
  healthUtilization, WAD,
} from './farm-math.mjs';

const Q96 = 1n << 96n;
const UINT128_MAX = (1n << 128n) - 1n;
// Solidity LiquidityAmounts casts each leg's result to uint128 BEFORE min(); a leg that
// overflows uint128 reverts (LIQ_OVERFLOW) even if the other leg is smaller.
function u128(x) { if (x > UINT128_MAX) throw new RangeError('LIQ_OVERFLOW: per-leg liquidity exceeds uint128'); return x; }

function big(x, name) {
  if (typeof x === 'number' && !Number.isSafeInteger(x)) throw new RangeError(`${name}: unsafe integer (pass as string)`);
  if (!['bigint', 'number', 'string'].includes(typeof x)) throw new TypeError(`${name}: integer required`);
  const v = BigInt(x);
  if (v < 0n) throw new RangeError(`${name}: negative`);
  return v;
}
function bool(x, name) { if (typeof x !== 'boolean') throw new TypeError(`${name}: boolean required`); return x; }

// Uniswap LiquidityAmounts.getLiquidityForAmount0/1 (integer, rounding down).
function liquidityForAmount0(sqrtA, sqrtB, amount0) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const intermediate = sqrtA * sqrtB / Q96;
  return amount0 * intermediate / (sqrtB - sqrtA);
}
function liquidityForAmount1(sqrtA, sqrtB, amount1) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return amount1 * Q96 / (sqrtB - sqrtA);
}
/** getLiquidityForAmounts: the largest liquidity a two-sided deposit of (amount0, amount1)
 * can mint into [sqrtA, sqrtB] at spot sqrtP. Mirrors Uniswap's min() of the two legs. */
export function getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1) {
  sqrtP = big(sqrtP, 'sqrtP'); sqrtA = big(sqrtA, 'sqrtA'); sqrtB = big(sqrtB, 'sqrtB');
  amount0 = big(amount0, 'amount0'); amount1 = big(amount1, 'amount1');
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA === 0n) throw new RangeError('sqrtA is zero');
  if (sqrtP <= sqrtA) return u128(liquidityForAmount0(sqrtA, sqrtB, amount0));
  if (sqrtP < sqrtB) {
    const l0 = u128(liquidityForAmount0(sqrtP, sqrtB, amount0));
    const l1 = u128(liquidityForAmount1(sqrtA, sqrtP, amount1));
    return l0 < l1 ? l0 : l1;
  }
  return u128(liquidityForAmount1(sqrtA, sqrtB, amount1));
}

/** Project position state after a dual open/increase.
 * args: {
 *   op: 'open' | 'increase',
 *   // current position (increase); open uses zeros
 *   liquidity, tickLower, tickUpper, dRisk, dLoan,
 *   // op params (raw token units), risk/loan legs
 *   investRisk, investLoan, borrowRisk, borrowLoan,
 *   // for open, the chosen range (ignored for increase which keeps current range)
 *   newTickLower, newTickUpper,
 *   // market/pricing
 *   riskPrice, loanPrice, dec0, dec1, riskIsToken0, lltv,
 * }
 * Returns { addedLiquidity, projected: {liquidity, dRisk, dLoan, valueInLoan, debtInLoan,
 *   capacity, headroom, isHealthy, healthBps}, current: {...}, estimate: true, caveats: [...] }.
 */
export function projectOpenIncrease(args) {
  const op = args.op;
  if (op !== 'open' && op !== 'increase') throw new RangeError("op must be 'open' or 'increase'");
  const riskIsToken0 = bool(args.riskIsToken0, 'riskIsToken0');
  const dec0 = big(args.dec0, 'dec0'), dec1 = big(args.dec1, 'dec1');
  const lltv = big(args.lltv, 'lltv');
  const riskPrice = big(args.riskPrice, 'riskPrice');
  const loanPrice = big(args.loanPrice, 'loanPrice');

  const curLiquidity = op === 'increase' ? big(args.liquidity, 'liquidity') : 0n;
  const curDRisk = op === 'increase' ? big(args.dRisk, 'dRisk') : 0n;
  const curDLoan = op === 'increase' ? big(args.dLoan, 'dLoan') : 0n;
  const tickLower = op === 'increase' ? BigInt(args.tickLower) : BigInt(args.newTickLower);
  const tickUpper = op === 'increase' ? BigInt(args.tickUpper) : BigInt(args.newTickUpper);
  if (tickLower >= tickUpper) throw new RangeError('tickLower must be below tickUpper');

  const investRisk = big(args.investRisk ?? 0n, 'investRisk');
  const investLoan = big(args.investLoan ?? 0n, 'investLoan');
  const borrowRisk = big(args.borrowRisk ?? 0n, 'borrowRisk');
  const borrowLoan = big(args.borrowLoan ?? 0n, 'borrowLoan');

  // Total risk/loan tokens available to deploy this op.
  const riskIn = investRisk + borrowRisk;
  const loanIn = investLoan + borrowLoan;
  // Map risk/loan legs onto token0/token1.
  const amount0 = riskIsToken0 ? riskIn : loanIn;
  const amount1 = riskIsToken0 ? loanIn : riskIn;

  // Spot sqrt price from the current feeds (same construction as the oracle).
  const price0 = riskIsToken0 ? riskPrice : loanPrice;
  const price1 = riskIsToken0 ? loanPrice : riskPrice;
  const sqrtP = sqrtPriceX96FromFeeds(price0, price1, dec0, dec1);
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);

  const addedLiquidity = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1);
  const newLiquidity = curLiquidity + addedLiquidity;
  if (newLiquidity > UINT128_MAX) throw new RangeError('projected liquidity exceeds uint128');

  // Upper-bound projected debt: full borrow added, no same-leg surplus repay credited.
  const projDRisk = curDRisk + borrowRisk;
  const projDLoan = curDLoan + borrowLoan;

  const shared = { tickLower, tickUpper, dec0, dec1, riskIsToken0, loanPrice, lltv, riskPrice };
  const projected = fairPositionAtRiskPrice({ ...shared, liquidity: newLiquidity, dRisk: projDRisk, dLoan: projDLoan });
  const projHealth = healthUtilization(projected.debtInLoan, projected.valueInLoan, lltv);

  const current = op === 'increase'
    ? (() => {
        const c = fairPositionAtRiskPrice({ ...shared, liquidity: curLiquidity, dRisk: curDRisk, dLoan: curDLoan });
        const h = healthUtilization(c.debtInLoan, c.valueInLoan, lltv);
        return { liquidity: curLiquidity, dRisk: curDRisk, dLoan: curDLoan,
          valueInLoan: c.valueInLoan, debtInLoan: c.debtInLoan, capacity: c.capacity,
          headroom: c.headroom, isHealthy: c.isHealthy, healthBps: h.healthBps };
      })()
    : null;

  return {
    op, estimate: true,
    addedLiquidity,
    projected: {
      liquidity: newLiquidity, dRisk: projDRisk, dLoan: projDLoan,
      valueInLoan: projected.valueInLoan, debtInLoan: projected.debtInLoan,
      capacity: projected.capacity, headroom: projected.headroom,
      isHealthy: projected.isHealthy, healthBps: projHealth.healthBps,
    },
    current,
    caveats: [
      'OPTIMISTIC estimate: assumes the full invest+borrow deploys as liquidity at the FEED spot with no same-leg surplus repay/refund.',
      'It can UNDERSTATE risk: if pool spot diverges from feeds, or a leg\'s surplus is refunded (no same-leg debt to repay) rather than deployed, real V/liquidity is lower and real health worse than shown.',
      'Debt side is an upper bound (borrow added, no surplus repay), so real net debt <= projected.',
      'NOT a health verdict. The authoritative healthy/unhealthy answer is the on-chain static pre-flight, which reverts UnhealthyOpen/UnhealthyIncrease when the real post-state fails. Use this number only to see the rough landing point.',
    ],
  };
}
