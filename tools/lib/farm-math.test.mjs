import test from 'node:test';
import assert from 'node:assert/strict';
import * as math from './farm-math.mjs';
const WAD = 10n ** 18n;
test('worked example: utilization and headroom use raw loan units', () => {
  const h = math.healthUtilization(6000n * WAD, 10000n * WAD, 770000000000000000n);
  assert.equal(h.healthBps, 7792n);
  assert.equal(h.capacity, 7700n * WAD);
  assert.equal(h.headroom, 1700n * WAD);
  assert.equal(h.isHealthy, true);
});
test('capacity equality stays healthy, one raw unit above is unhealthy', () => {
  assert.equal(math.healthUtilization(7n, 10n, 770000000000000000n).isHealthy, true);
  assert.equal(math.healthUtilization(8n, 10n, 770000000000000000n).isHealthy, false);
  assert.equal(math.healthUtilization(7n, 10n, 770000000000000000n).healthBps, 9090n);
});
test('zero value debt is infinite; empty position is inactive', () => {
  assert.equal(math.healthUtilization(1n, 0n, WAD).note, 'infinite');
  assert.equal(math.healthUtilization(1n, 0n, WAD).healthBps, null);
  assert.equal(math.healthUtilization(0n, 0n, WAD).isHealthy, null);
});
test('farm utilization is reciprocal to the lending capacity/debt factor before display rounding', () => {
  const h = math.healthUtilization(500n, 1000n, WAD);
  assert.equal(h.healthBps, 5000n);
  assert.equal(h.capacity * 10000n / 500n, 20000n);
  assert.equal(h.healthBps * 20000n, 10000n ** 2n);
});
test('slippage floors minima and ceils maxima including fractional raw units', () => {
  assert.equal(math.slippageFloor(101n, 1n), 100n);
  assert.equal(math.slippageCeil(101n, 1n), 102n);
  assert.equal(math.slippageFloor(999n, 10000n), 0n);
  assert.equal(math.slippageCeil(100n, 0n), 100n);
  assert.throws(() => math.slippageFloor(1n, 10001n));
});
const feed = {answer:100000000n, updatedAt:1000n, roundId:3n, answeredInRound:3n, now:1100n, maxStaleness:100n};
test('feed exact staleness limit is fresh', () => {
  assert.deepEqual(math.evalFeed(feed), {fresh:true, ageSeconds:100n, failClosed:false, reason:null});
});
test('feed invalid rounds and stale/nonpositive/future values fail closed', () => {
  for (const change of [{roundId:0n}, {answeredInRound:2n}, {updatedAt:0n}, {now:1101n}, {answer:0n}, {answer:-1n}, {updatedAt:1101n}]) {
    const result = math.evalFeed({...feed, ...change});
    assert.equal(result.failClosed, true);
    assert.equal(result.fresh, false);
  }
});
test('depeg constructor floors both inclusive bounds in native feed units', () => {
  assert.equal(math.evalDepeg({usdgPrice:99500000n, depegBps:50n, feedDecimals:8n}).inBand, true);
  assert.equal(math.evalDepeg({usdgPrice:100500000n, depegBps:50n, feedDecimals:8n}).inBand, true);
  assert.equal(math.evalDepeg({usdgPrice:100500001n, depegBps:50n, feedDecimals:8n}).inBand, false);
  assert.equal(math.evalDepeg({usdgPrice:99n, depegBps:50n, feedDecimals:2n}).inBand, true);
  assert.equal(math.evalDepeg({usdgPrice:101n, depegBps:50n, feedDecimals:2n}).inBand, false);
});
test('TickMath matches Solidity extremal and zero sqrt values', () => {
  assert.equal(math.getSqrtRatioAtTick(0n), 1n << 96n);
  assert.equal(math.getSqrtRatioAtTick(-887272n), 4295128739n);
  assert.equal(math.getSqrtRatioAtTick(887272n), 1461446703485210103287273052203988822378723970342n);
  assert.throws(() => math.getSqrtRatioAtTick(887273n));
});
test('tick price handles token decimals and reciprocal risk mapping', () => {
  assert.deepEqual(math.tickToPrice(0n, 18n, 6n, true), {mantissa:10n ** 48n, scale:10n ** 36n});
  assert.deepEqual(math.tickToPrice(0n, 18n, 6n, false), {mantissa:10n ** 24n, scale:10n ** 36n});
  assert.equal(math.tickToPrice(100n, 18n, 18n, true).mantissa > math.PRICE_SCALE, true);
  assert.equal(math.tickToPrice(100n, 18n, 18n, false).mantissa < math.PRICE_SCALE, true);
});
test('LiquidityAmounts preserves double floor below, inside, and above the range', () => {
  const q = 1n << 96n;
  assert.deepEqual(math.amountsForLiquidity(100n, q, 2n*q, 4n*q), {amount0:25n,amount1:0n});
  assert.deepEqual(math.amountsForLiquidity(100n, 3n*q, 2n*q, 4n*q), {amount0:8n,amount1:100n});
  assert.deepEqual(math.amountsForLiquidity(100n, 4n*q, 2n*q, 4n*q), {amount0:0n,amount1:200n});
});
test('feed fair sqrt matches rational integer sqrt including upper-domain branch', () => {
  assert.equal(math.sqrtPriceX96FromFeeds(1n,1n,18n,18n),1n << 96n);
  assert.equal(math.sqrtPriceX96FromFeeds(4n,1n,18n,18n),2n << 96n);
  assert.equal(math.sqrtPriceX96FromFeeds(1n << 100n,1n,0n,0n),1n << 146n);
  assert.throws(() => math.sqrtPriceX96FromFeeds(1n << 128n,1n,0n,0n), /SQRT_RANGE/);
});
const base = {liquidity:1000000n,tickLower:-10000n,tickUpper:10000n,dec0:0n,dec1:0n,riskIsToken0:true,lltv:770000000000000000n,loanPrice:100n};
test('fair valuation preserves per-leg feed truncation and debt conversion', () => {
  const v = math.fairPositionAtRiskPrice({...base,riskPrice:100n,dRisk:13n,dLoan:7n});
  // At price 1 both source-rounded amounts are floor(1e6*(1-1/sqrt(1.0001^10000))).
  assert.equal(v.amount0,393454n);
  assert.equal(v.amount1,393454n);
  assert.equal(v.valueInLoan,786908n);
  assert.equal(v.debtInLoan,20n);
  assert.equal(v.capacity,605919n);
  const dust = math.fairPositionAtRiskPrice({...base,dec0:18n,dec1:18n,liquidity:10n**18n,riskPrice:100n,dRisk:13n,dLoan:7n});
  assert.equal(dust.valueInLoan,780000000000000000n);
  assert.equal(dust.debtInLoan,20n);
});
test('dual boundary search finds separate adjacent transitions beyond both LP endpoints', () => {
  const args = {...base,currentRiskPrice:100n,dRisk:200000n,dLoan:200000n};
  const roots = math.dualLiquidationBoundaries(args);
  assert.ok(roots.lower && roots.upper);
  assert.ok(roots.lower.riskPrice < 37n);
  assert.ok(roots.upper.riskPrice > 271n);
  for (const root of [roots.lower,roots.upper]) {
    assert.equal(root.bracket.upper.riskPrice-root.bracket.lower.riskPrice,1n);
    assert.equal(root.healthy.isHealthy,true);
    assert.equal(root.unhealthy.isHealthy,false);
    assert.ok(root.healthy.capacity >= root.healthy.debtInLoan);
    assert.ok(root.unhealthy.debtInLoan > root.unhealthy.capacity);
  }
});
test('single shape returns one constant-loan-debt boundary, including unhealthy starting price', () => {
  const args = {...base,currentRiskPrice:100n,dLoan:400000n};
  const root = math.singleLiquidationBoundary(args);
  assert.ok(root);
  assert.ok(root.riskPrice < 100n);
  assert.equal(root.healthy.debtInLoan,400000n);
  assert.equal(root.unhealthy.debtInLoan,400000n);
  const fromBelow = math.singleLiquidationBoundary({...args,currentRiskPrice:1n});
  assert.equal(fromBelow.riskPrice,root.riskPrice);
  assert.equal(fromBelow.direction,'upper');
  assert.equal(math.singleLiquidationBoundary({...args,dLoan:0n}),null);
  assert.throws(() => math.singleLiquidationBoundary({...args,dRisk:1n}), /single/);
});
test('nearest dual transitions match exhaustive native-feed enumeration for both token orderings', () => {
  for (const riskIsToken0 of [true,false]) for (const dRisk of [0n,200000n,700000n]) for (const currentRiskPrice of [10n,100n,400n]) {
    const args = {...base,riskIsToken0,dRisk,dLoan:200000n,currentRiskPrice,minRiskPrice:1n,maxRiskPrice:500n};
    const roots = math.dualLiquidationBoundaries(args);
    const initial = math.fairPositionAtRiskPrice({...args,riskPrice:currentRiskPrice}).isHealthy;
    for (const direction of ['lower','upper']) {
      const step = direction === 'lower' ? -1n : 1n;
      let expected = null;
      for (let p = currentRiskPrice+step; p >= 1n && p <= 500n; p += step) {
        if (math.fairPositionAtRiskPrice({...args,riskPrice:p}).isHealthy !== initial) { expected = p; break; }
      }
      const found = roots[direction];
      assert.equal(found === null,expected === null);
      if (found) assert.equal(direction === 'lower' ? found.bracket.lower.riskPrice : found.bracket.upper.riskPrice,expected);
    }
  }
});
test('no-debt, zero-liquidity and one-sided no-root cases are explicit', () => {
  assert.deepEqual(math.dualLiquidationBoundaries({...base,currentRiskPrice:100n,dRisk:0n,dLoan:0n}),{lower:null,upper:null});
  assert.deepEqual(math.dualLiquidationBoundaries({...base,currentRiskPrice:100n,liquidity:0n,dRisk:0n,dLoan:1n}),{lower:null,upper:null});
  assert.equal(math.dualLiquidationBoundaries({...base,currentRiskPrice:100n,dRisk:0n,dLoan:200000n}).upper,null);
});
test('uncertified search budget throws rather than reporting absent roots', () => {
  assert.throws(() => math.dualLiquidationBoundaries({...base,currentRiskPrice:100n,dRisk:200000n,dLoan:200000n,maxEvaluations:1n}),/SEARCH_LIMIT/);
});
test('realistic mixed decimals boundary search completes within default certification budget', () => {
  const args = {liquidity:10n**15n,tickLower:-201000n,tickUpper:-199000n,dec0:18n,dec1:6n,riskIsToken0:true,lltv:770000000000000000n,loanPrice:100000000n,currentRiskPrice:206300000000n};
  const v = math.fairPositionAtRiskPrice({...args,riskPrice:args.currentRiskPrice});
  const roots = math.dualLiquidationBoundaries({...args,dRisk:v.amount0/2n,dLoan:v.amount1/2n});
  assert.ok(roots.lower && roots.upper);
  assert.equal(roots.lower.bracket.upper.riskPrice-roots.lower.bracket.lower.riskPrice,1n);
  assert.equal(roots.upper.bracket.upper.riskPrice-roots.upper.bracket.lower.riskPrice,1n);
});
test('oracle answers outside signed int256 fail before valuation', () => {
  assert.throws(() => math.fairPositionAtRiskPrice({...base,riskPrice:1n << 255n}), /int256/);
  assert.throws(() => math.fairPositionAtRiskPrice({...base,riskPrice:100n,loanPrice:1n << 255n}), /int256/);
});
test('independent checked-in Solidity differential golden fixtures match exact values', () => {
  // Copied immutable fixtures, so tests do not depend on the adjacent leverage checkout.
  // leverage/test/vectors/feed_sqrt.json rows 1 and 3; fair_lp.json row 0.
  assert.equal(math.sqrtPriceX96FromFeeds(450000000000n,100000000n,18n,18n),5314786713428871308883051484821n);
  assert.equal(math.sqrtPriceX96FromFeeds(633025492580n,16224578540n,6n,6n),494884066851285559928473688129n);
  const amounts = math.amountsForLiquidity(1000000000000000000n,5314113777224563525580347457454n,
    math.getSqrtRatioAtTick(83520n),math.getSqrtRatioAtTick(84720n));
  assert.deepEqual(amounts,{amount0:440606062812034n,amount1:1982225225064573645n});
  assert.equal(amounts.amount0*450000000000n/WAD + amounts.amount1*100000000n/WAD,396495250n);
});
test('candidate search does not conceal Solidity arithmetic reverts inside a skipped interval', () => {
  // Interior amount0*price0 exceeds uint256 although BOTH shell endpoints are valid.
  const loanPrice = 424n*10n**38n, unit = loanPrice*WAD;
  const args = {liquidity:WAD,tickLower:0n,tickUpper:47877n,dec0:18n,dec1:0n,riskIsToken0:true,
    lltv:1n,loanPrice,currentRiskPrice:50n*unit,dRisk:0n,dLoan:1n,
    minRiskPrice:25n*unit,maxRiskPrice:50n*unit};
  assert.equal(math.fairPositionAtRiskPrice({...args,riskPrice:25n*unit}).isHealthy,true);
  assert.equal(math.fairPositionAtRiskPrice({...args,riskPrice:50n*unit}).isHealthy,true);
  assert.throws(() => math.fairPositionAtRiskPrice({...args,riskPrice:30n*unit}), /overflow/);
  assert.throws(() => math.dualLiquidationBoundaries(args), /overflow/);
});
test('worked USDG example also reproduces exact six-decimal raw units', () => {
  const result = math.healthUtilization(6000000000n,10000000000n,770000000000000000n);
  assert.equal(result.healthBps,7792n);
  assert.equal(result.capacity,7700000000n);
  assert.equal(result.headroom,1700000000n);
});
test('boundary bracket retains exact capacity-debt equality on the healthy side', () => {
  const root = math.singleLiquidationBoundary({...base,currentRiskPrice:100n,dLoan:605919n});
  assert.equal(root.healthy.riskPrice,100n);
  assert.equal(root.healthy.capacity,root.healthy.debtInLoan);
  assert.equal(root.unhealthy.riskPrice,99n);
  assert.equal(root.unhealthy.isHealthy,false);
});
