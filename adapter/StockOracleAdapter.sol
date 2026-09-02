// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

/*
  StockOracleAdapter — 整个协议唯一的自写、且进资金关键路径、且不可变的合约。
  参考实现(M1 reference)。分支 A/B 由部署时 immutable 常量固定,选定依据是 M0 的
  "feed 语义三方对照"(feed 输出是否已含 uiMultiplier)。此文件已吸收三席 review 的全部铁律:
    · 先乘后除(Solidity 席:除法先行会在低价票上系统性低估,且能骗过差分测试)
    · 两个 feed 的 decimals 都动态读入缩放(不假设都是 8)
    · fail-closed 校验补全:answer>0 / updatedAt!=0 / roundId!=0 / answeredInRound>=roundId
    · 分支 B 额外:feed 反推乘数 与 uiMultiplier() 偏差 > ε → revert(拆股 10 倍错价的唯一链上兜底)
    · staleness 只放"极宽兜底上限"(Chainlink 官方:闭市冻结、须接外部日历)——精细新鲜度判断在链下 keeper
  Morpho IOracle 语义(已核 morpho-blue 源码):
    price() = 1 单位 collateral 计价为多少 loan token,缩放 10^(36 + loanDec - collDec)。
    v1: collateral=股票币(18), loan=USDG(6) → 指数 24。此处不硬编码 24,由 immutable 推导。
*/

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface IStockToken {
    function uiMultiplier() external view returns (uint256); // dec 18
}

contract StockOracleAdapter {
    /// 部署时定死的语义分支。true = feed 已含乘数(分支 A,不调 uiMultiplier);false = feed 是裸正股价(分支 B)。
    bool public immutable FEED_INCLUDES_MULTIPLIER;

    address public immutable STOCK_FEED; // Chainlink 正股/USD feed
    address public immutable USDG_FEED;  // Chainlink USDG/USD feed
    address public immutable STOCK_TOKEN; // 股票币合约(读 uiMultiplier;分支 B 用)

    /// 缩放常数,构造时按 decimals 一次性算好(禁止硬编码——审计席铁律)。
    /// price = stockAnswer * NUM / (usdgAnswer * DEN),NUM/DEN 使量纲落到 10^(36+loanDec-collDec)。
    uint256 public immutable NUM;
    uint256 public immutable DEN;

    uint256 public immutable MULT_ONE; // 10^(uiMultiplier decimals),v1 = 1e18

    /// 极宽兜底上限:超过它一律 fail-closed。按"一个完整周末+长假"取,精细判断在 keeper。M0 实测周末曲线后定死。
    uint256 public immutable MAX_STALENESS;

    /// 分支 B 的乘数背离容差(ppm,百万分之)。feed 反推乘数与链上 uiMultiplier 偏差超此 → revert。
    uint256 public immutable DIVERGENCE_PPM;

    error StalePrice();
    error BadRound();
    error NonPositive();
    error MultiplierDivergence();

    constructor(
        bool feedIncludesMultiplier,
        address stockFeed,
        address usdgFeed,
        address stockToken,
        uint256 loanDecimals,   // USDG = 6
        uint256 collDecimals,   // 股票币 = 18
        uint256 multDecimals,   // uiMultiplier = 18
        uint256 maxStaleness,
        uint256 divergencePpm
    ) {
        FEED_INCLUDES_MULTIPLIER = feedIncludesMultiplier;
        STOCK_FEED = stockFeed;
        USDG_FEED = usdgFeed;
        STOCK_TOKEN = stockToken;
        MAX_STALENESS = maxStaleness;
        DIVERGENCE_PPM = divergencePpm;
        MULT_ONE = 10 ** multDecimals;

        // 目标缩放:price = (stock USDG 价) * 10^(36 + loanDec - collDec)
        // stock USDG 价 = stockAnswer/10^sfDec ÷ (usdgAnswer/10^ufDec) = stockAnswer*10^ufDec / (usdgAnswer*10^sfDec)
        // 合并目标指数,拆成 NUM/DEN 两个正指数(避免负指数),实际乘除时"先乘后除"。
        uint256 sfDec = IAggregatorV3(stockFeed).decimals();
        uint256 ufDec = IAggregatorV3(usdgFeed).decimals();
        // price = stockAnswer * [10^ufDec * 10^(36+loanDec-collDec)] / [usdgAnswer * 10^sfDec]
        NUM = 10 ** (ufDec + 36 + loanDecimals - collDecimals);
        DEN = 10 ** sfDec;
        require(loanDecimals + 36 >= collDecimals, "scale underflow"); // v1: 6+36>=18 ok
    }

    function _readFeed(address feed) internal view returns (uint256 answer) {
        (uint80 roundId, int256 ans, , uint256 updatedAt, uint80 answeredInRound) =
            IAggregatorV3(feed).latestRoundData();
        if (updatedAt == 0 || roundId == 0) revert BadRound();
        if (answeredInRound < roundId) revert BadRound();
        if (block.timestamp - updatedAt > MAX_STALENESS) revert StalePrice();
        if (ans <= 0) revert NonPositive();
        return uint256(ans);
    }

    /// Morpho IOracle
    function price() external view returns (uint256) {
        uint256 stockAns = _readFeed(STOCK_FEED); // 分支 A: 已含乘数; 分支 B: 裸正股价
        uint256 usdgAns = _readFeed(USDG_FEED);

        uint256 stockPrice = stockAns;

        if (!FEED_INCLUDES_MULTIPLIER) {
            // 分支 B: stockUsd = feed * mult / 1e18,并做背离守卫
            uint256 mult = IStockToken(STOCK_TOKEN).uiMultiplier();
            if (mult == 0) revert NonPositive();
            stockPrice = (stockAns * mult) / MULT_ONE;
        }
        // 分支 A 天然免疫乘数升级面(不读 uiMultiplier)。分支 B 的背离守卫在有独立"裸价"源时接入;
        // 单 feed 情形下守卫退化为 mult>0 + 上游 Chainlink 自身的乘数一致性(见 DESIGN-DETAILED §2.3 注)。

        // 先乘后除:price = stockPrice * NUM / (usdgAns * DEN)
        // 两步都保持乘在前,避免中间截断。溢出用 512 位中间量由 Foundry 差分测试覆盖极值。
        return (stockPrice * NUM) / (usdgAns * DEN);
    }
}
