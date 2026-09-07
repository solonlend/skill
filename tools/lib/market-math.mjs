// Dependency-free integer math for the Solon Morpho market reader.
export const WAD = 10n ** 18n;
export const ORACLE_PRICE_SCALE = 10n ** 36n;
export const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
const MAX_UINT256 = (1n << 256n) - 1n;

function uint(value, name) {
  if (typeof value !== 'bigint' || value < 0n) throw new RangeError(`${name} must be a nonnegative BigInt`);
  return value;
}

function bounded(value) {
  if (value > MAX_UINT256) throw new RangeError('Fixed-point APY exceeds uint256');
  return value;
}

/** (1 + rate / 1e18)^seconds - 1, as WAD. Exponentiation by squaring;
 * floor after EACH WAD multiplication (a downward approximation, not one final
 * rounding of the exact rational power). Year = 365 days, frozen current rate.
 * This display convention is not Morpho's Taylor interest-accrual algorithm.
 */
export function apyFromRate(rate, seconds = SECONDS_PER_YEAR) {
  uint(rate, 'rate');
  uint(seconds, 'seconds');
  let base = bounded(WAD + rate), result = WAD;
  while (seconds > 0n) {
    if (seconds & 1n) result = bounded(result * base / WAD);
    seconds >>= 1n;
    if (seconds > 0n) base = bounded(base * base / WAD);
  }
  return result - WAD;
}

export function utilization(borrowAssets, supplyAssets) {
  uint(borrowAssets, 'borrowAssets');
  uint(supplyAssets, 'supplyAssets');
  if (borrowAssets > supplyAssets) throw new RangeError('Borrow assets exceed supply assets');
  return supplyAssets === 0n ? 0n : borrowAssets * WAD / supplyAssets;
}

export function supplyApy(borrowApy, utilizationWad, feeWad) {
  uint(borrowApy, 'borrowApy');
  uint(utilizationWad, 'utilizationWad');
  uint(feeWad, 'feeWad');
  if (utilizationWad > WAD || feeWad > WAD) throw new RangeError('Utilization and fee must be at most WAD');
  return (borrowApy * utilizationWad / WAD) * (WAD - feeWad) / WAD;
}

/** Human collateral/loan price multiplier. Base-unit valuation always divides
 * collateral * rawPrice by 1e36, NOT by this human-price multiplier. */
export function deriveOracleScale(loanDecimals, collateralDecimals) {
  uint(loanDecimals, 'loanDecimals');
  uint(collateralDecimals, 'collateralDecimals');
  if (loanDecimals > 255n || collateralDecimals > 255n) throw new RangeError('Decimals must fit uint8');
  const exponent = 36n + loanDecimals - collateralDecimals;
  return { exponent, numerator: exponent >= 0n ? 10n ** exponent : 1n,
    denominator: exponent < 0n ? 10n ** -exponent : 1n };
}

const ceilDiv = (a, b) => (a + b - 1n) / b;

/** AGENT-GUIDE §1 / SharesMathLib: VIRTUAL_ASSETS=1, VIRTUAL_SHARES=1e6.
 * Suppliers round down; borrower liability must round up. Totals are supplied
 * explicitly so callers cannot silently confuse checkpoints with accrued totals.
 */
export function sharesToAssets(shares, totalAssets, totalShares, rounding = 'down') {
  uint(shares, 'shares');
  uint(totalAssets, 'totalAssets');
  uint(totalShares, 'totalShares');
  if (rounding !== 'down' && rounding !== 'up') throw new RangeError('Invalid rounding');
  const numerator = shares * (totalAssets + 1n), denominator = totalShares + 1_000_000n;
  return rounding === 'up' ? ceilDiv(numerator, denominator) : numerator / denominator;
}

/** AGENT-GUIDE §3: floor collateral valuation, then floor LLTV capacity.
 * Debt > capacity is liquidatable; equality is healthy. Debt-free HF is null
 * (unbounded), never a manufactured finite number. The boundary is the smallest
 * integer oracle price that covers debt after BOTH floors, for frozen debt.
 */
export function lendingHealth({ collateral, price, lltv, debt }) {
  for (const [name, value] of Object.entries({ collateral, price, lltv, debt })) uint(value, name);
  if (price === 0n || lltv > WAD) throw new RangeError('Invalid oracle price or LLTV');
  const valueInLoan = collateral * price / ORACLE_PRICE_SCALE;
  const maxBorrow = valueInLoan * lltv / WAD;
  const minHealthyOraclePrice = debt === 0n ? 0n : collateral === 0n || lltv === 0n ? null
    : ceilDiv(ceilDiv(debt * WAD, lltv) * ORACLE_PRICE_SCALE, collateral);
  return { valueInLoan, maxBorrow, debt, debtFree: debt === 0n,
    healthFactorWad: debt === 0n ? null : maxBorrow * WAD / debt,
    isHealthy: debt <= maxBorrow, liquidatable: debt > maxBorrow,
    headroom: maxBorrow - debt, minHealthyOraclePrice };
}
