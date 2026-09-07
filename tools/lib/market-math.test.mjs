import test from 'node:test';
import assert from 'node:assert/strict';
import * as math from './market-math.mjs';

test('APY uses a 365-day year and zero rate produces zero yield', () => {
  assert.equal(math.SECONDS_PER_YEAR, 31_536_000n);
  assert.equal(math.apyFromRate(0n), 0n);
});

test('APY compounds every second with downward fixed-point rounding', () => {
  const rate = 1_000_000_000n;
  const actual = math.apyFromRate(rate);
  // Independent floating-point approximation is only a test oracle, never production math.
  const expected = Math.expm1(31_536_000 * Math.log1p(1e-9));
  assert.ok(Math.abs(Number(actual) / 1e18 - expected) < 1e-10);
  assert.ok(actual > rate * 31_536_000n);
  assert.equal(math.apyFromRate(500_000_000_000_000_000n, 3n), 2_375_000_000_000_000_000n);
  assert.equal(math.apyFromRate(1n, 2n), 2n);
});

test('APY rejects invalid inputs and impractically large fixed-point results', () => {
  assert.throws(() => math.apyFromRate(-1n));
  assert.throws(() => math.apyFromRate(1));
  assert.throws(() => math.apyFromRate(1n, -1n));
  assert.throws(() => math.apyFromRate(10n ** 18n));
});

test('utilization handles empty markets and floors repeating fractions', () => {
  assert.equal(math.utilization(0n, 0n), 0n);
  assert.equal(math.utilization(1n, 3n), 333_333_333_333_333_333n);
  assert.equal(math.utilization(3n, 3n), math.WAD);
  assert.throws(() => math.utilization(1n, 0n), RangeError);
  assert.throws(() => math.utilization(4n, 3n), RangeError);
});

test('supply APY deducts the interest fee after utilization with downward rounding', () => {
  assert.equal(math.supplyApy(100_000_000_000_000_000n, math.WAD / 2n, math.WAD / 10n), 45_000_000_000_000_000n);
  assert.equal(math.supplyApy(math.WAD, 0n, 0n), 0n);
  assert.equal(math.supplyApy(math.WAD, math.WAD, math.WAD), 0n);
  assert.equal(math.supplyApy(3n, math.WAD / 2n, math.WAD / 2n), 0n);
  assert.throws(() => math.supplyApy(math.WAD, math.WAD, math.WAD + 1n), RangeError);
});

test('oracle scale follows token decimals, including negative exponents', () => {
  assert.deepEqual(math.deriveOracleScale(6n, 18n), { exponent: 24n, numerator: 10n ** 24n, denominator: 1n });
  assert.equal(math.deriveOracleScale(18n, 6n).numerator, 10n ** 48n);
  assert.equal(math.deriveOracleScale(18n, 18n).numerator, 10n ** 36n);
  assert.deepEqual(math.deriveOracleScale(0n, 37n), { exponent: -1n, numerator: 1n, denominator: 10n });
  assert.throws(() => math.deriveOracleScale(256n, 18n), RangeError);
  assert.throws(() => math.deriveOracleScale(6n, -1n), RangeError);
});

test('Morpho share conversion includes virtual assets/shares and debt rounds up', () => {
  assert.equal(math.sharesToAssets(1_000_000n, 0n, 0n), 1n);
  assert.equal(math.sharesToAssets(1n, 100n, 100n), 0n);
  assert.equal(math.sharesToAssets(1n, 100n, 100n, 'up'), 1n);
  assert.equal(math.sharesToAssets(0n, 100n, 100n, 'up'), 0n);
  assert.throws(() => math.sharesToAssets(-1n, 0n, 0n), RangeError);
});

test('lending health uses base-unit 1e36 valuation and LLTV, with equality healthy', () => {
  const args = { collateral: 10n ** 18n, price: 100n * 10n ** 24n, lltv: 385_000_000_000_000_000n, debt: 38_500_000n };
  const h = math.lendingHealth(args);
  assert.equal(h.valueInLoan, 100_000_000n);
  assert.equal(h.maxBorrow, 38_500_000n);
  assert.equal(h.healthFactorWad, math.WAD);
  assert.equal(h.isHealthy, true);
  assert.equal(h.liquidatable, false);
  assert.equal(math.lendingHealth({ ...args, debt: args.debt + 1n }).liquidatable, true);
});

test('liquidation boundary respects both contract floors on the integer price lattice', () => {
  const args = { collateral: 3n, price: 2n * 10n ** 36n, lltv: math.WAD / 2n, debt: 2n };
  const h = math.lendingHealth(args);
  assert.equal(h.minHealthyOraclePrice, (4n * 10n ** 36n + 2n) / 3n);
  assert.equal(math.lendingHealth({ ...args, price: h.minHealthyOraclePrice }).isHealthy, true);
  assert.equal(math.lendingHealth({ ...args, price: h.minHealthyOraclePrice - 1n }).liquidatable, true);
});

test('zero debt is debt-free, while zero collateral or LLTV cannot cover debt', () => {
  const args = { collateral: 0n, price: 1n, lltv: 0n, debt: 0n };
  const empty = math.lendingHealth(args);
  assert.equal(empty.isHealthy, true);
  assert.equal(empty.healthFactorWad, null);
  assert.equal(empty.debtFree, true);
  assert.equal(empty.minHealthyOraclePrice, 0n);
  assert.equal(math.lendingHealth({ ...args, debt: 1n }).minHealthyOraclePrice, null);
  assert.equal(math.lendingHealth({ ...args, debt: 1n }).liquidatable, true);
});

test('invalid oracle prices never produce lending health', () => {
  const args = { collateral: 1n, price: 0n, lltv: math.WAD, debt: 1n };
  assert.throws(() => math.lendingHealth(args), RangeError);
  assert.throws(() => math.lendingHealth({ ...args, price: -1n }), RangeError);
  assert.throws(() => math.lendingHealth({ ...args, price: 1n, lltv: math.WAD + 1n }), RangeError);
});
