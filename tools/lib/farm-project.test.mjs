// SPDX-License-Identifier: GPL-2.0-or-later
// Offline tests for farm-project.mjs. No dependencies. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLiquidityForAmounts, projectOpenIncrease } from './farm-project.mjs';
import { getSqrtRatioAtTick, amountsForLiquidity, sqrtPriceX96FromFeeds } from './farm-math.mjs';

// Symmetric 18/18-decimal setup with equal feed prices => raw price 1 => spot at tick 0,
// so a range of ±600 GENUINELY straddles spot (the earlier ±60/18-6 fixture sat below range).
const DEC = 18n;
const TICK_LOWER = -600n, TICK_UPPER = 600n;
const LLTV = 770000000000000000n;
const PRICE = 1_00000000n; // both feeds $1, 8-dec

function spotSqrt() { return sqrtPriceX96FromFeeds(PRICE, PRICE, DEC, DEC); }

test('spot truly straddles the test range (sanity: both legs consumed)', () => {
  const sqrtP = spotSqrt(), sqrtA = getSqrtRatioAtTick(TICK_LOWER), sqrtB = getSqrtRatioAtTick(TICK_UPPER);
  assert.ok(sqrtP > sqrtA && sqrtP < sqrtB, 'spot must be inside the range');
  const { amount0, amount1 } = amountsForLiquidity(1_000_000_000_000n, sqrtP, sqrtA, sqrtB);
  assert.ok(amount0 > 0n && amount1 > 0n, 'a straddling range consumes both tokens');
});

test('getLiquidityForAmounts inverts amountsForLiquidity within rounding (in range)', () => {
  const L = 5_000_000_000_000n;
  const sqrtA = getSqrtRatioAtTick(TICK_LOWER), sqrtB = getSqrtRatioAtTick(TICK_UPPER), sqrtP = spotSqrt();
  const { amount0, amount1 } = amountsForLiquidity(L, sqrtP, sqrtA, sqrtB);
  const Lback = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1);
  assert.ok(Lback <= L, `Lback ${Lback} must be <= L ${L}`);
  assert.ok(L - Lback <= L / 1_000_000n + 2n, `rounding gap too large: ${L - Lback}`);
});

test('getLiquidityForAmounts: below range uses amount0 only', () => {
  const sqrtA = getSqrtRatioAtTick(120n), sqrtB = getSqrtRatioAtTick(240n), sqrtP = getSqrtRatioAtTick(0n);
  const L = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, 1_000_000_000_000_000_000n, 0n);
  assert.ok(L > 0n);
  assert.equal(L, getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, 1_000_000_000_000_000_000n, 999n));
});

test('getLiquidityForAmounts: above range uses amount1 only', () => {
  const sqrtA = getSqrtRatioAtTick(-240n), sqrtB = getSqrtRatioAtTick(-120n), sqrtP = getSqrtRatioAtTick(0n);
  const L = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, 0n, 1_000_000n);
  assert.ok(L > 0n);
  assert.equal(L, getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, 12345n, 1_000_000n));
});

test('getLiquidityForAmounts throws LIQ_OVERFLOW when a per-leg result exceeds uint128', () => {
  const Q = 1n << 96n;
  assert.throws(() => getLiquidityForAmounts(Q, Q / 2n, 2n * Q, 1n << 128n, 1n), /LIQ_OVERFLOW/);
});

const BASE = { riskPrice: PRICE, loanPrice: PRICE, dec0: DEC, dec1: DEC, riskIsToken0: true, lltv: LLTV };

test('open with only equity (no borrow) is healthy (D=0 => isHealthy true)', () => {
  const r = projectOpenIncrease({ op: 'open', newTickLower: TICK_LOWER, newTickUpper: TICK_UPPER,
    investRisk: 1_000_000_000_000_000_000n, investLoan: 1_000_000_000_000_000_000n,
    borrowRisk: 0n, borrowLoan: 0n, ...BASE });
  assert.ok(r.projected.valueInLoan > 0n && r.projected.debtInLoan === 0n);
  assert.equal(r.projected.isHealthy, true, 'a debt-free position is healthy');
  assert.equal(r.current, null);
});

test('open at high leverage relative to equity is flagged UNHEALTHY (isHealthy false)', () => {
  // Tiny equity, large borrow => debt far exceeds capacity => must be flagged unhealthy.
  const r = projectOpenIncrease({ op: 'open', newTickLower: TICK_LOWER, newTickUpper: TICK_UPPER,
    investRisk: 1_000_000n, investLoan: 1_000_000n,
    borrowRisk: 0n, borrowLoan: 1_000_000_000_000_000_000n, ...BASE });
  assert.equal(r.projected.isHealthy, false, 'over-borrowed open must be flagged unhealthy, not healthy');
  assert.ok(r.projected.headroom < 0n);
});

test('riskIsToken0=false mapping still produces a coherent position', () => {
  const r0 = projectOpenIncrease({ op: 'open', newTickLower: TICK_LOWER, newTickUpper: TICK_UPPER,
    investRisk: 1_000_000_000_000_000_000n, investLoan: 1_000_000_000_000_000_000n,
    borrowRisk: 0n, borrowLoan: 0n, ...BASE });
  const r1 = projectOpenIncrease({ op: 'open', newTickLower: TICK_LOWER, newTickUpper: TICK_UPPER,
    investRisk: 1_000_000_000_000_000_000n, investLoan: 1_000_000_000_000_000_000n,
    borrowRisk: 0n, borrowLoan: 0n, ...BASE, riskIsToken0: false });
  // Symmetric prices/decimals: value is identical regardless of which token is risk.
  assert.ok(r0.projected.valueInLoan > 0n && r1.projected.valueInLoan > 0n);
  assert.equal(r0.projected.valueInLoan, r1.projected.valueInLoan);
});

test('increase adds liquidity and grows debt by the borrow legs', () => {
  const base = projectOpenIncrease({ op: 'open', newTickLower: TICK_LOWER, newTickUpper: TICK_UPPER,
    investRisk: 1_000_000_000_000_000_000n, investLoan: 1_000_000_000_000_000_000n,
    borrowRisk: 0n, borrowLoan: 0n, ...BASE });
  const r = projectOpenIncrease({ op: 'increase',
    liquidity: base.projected.liquidity, tickLower: TICK_LOWER, tickUpper: TICK_UPPER, dRisk: 0n, dLoan: 0n,
    investRisk: 0n, investLoan: 0n, borrowRisk: 500_000_000_000_000_000n, borrowLoan: 500_000_000_000_000_000n, ...BASE });
  assert.ok(r.projected.liquidity > base.projected.liquidity, 'liquidity must grow');
  assert.equal(r.projected.dRisk, 500_000_000_000_000_000n);
  assert.equal(r.projected.dLoan, 500_000_000_000_000_000n);
  assert.ok(r.current !== null && r.current.debtInLoan === 0n);
});

test('unsafe JS number param is rejected (must pass as string)', () => {
  assert.throws(() => projectOpenIncrease({ op: 'open', newTickLower: TICK_LOWER, newTickUpper: TICK_UPPER,
    investRisk: 9007199254740993, investLoan: 0n, borrowRisk: 0n, borrowLoan: 0n, ...BASE }), /unsafe integer/);
});

test('projectOpenIncrease rejects bad op / inverted range', () => {
  assert.throws(() => projectOpenIncrease({ op: 'close' }), /op must be/);
  assert.throws(() => projectOpenIncrease({ op: 'open', newTickLower: 600n, newTickUpper: -600n, ...BASE }),
    /tickLower must be below tickUpper/);
});
