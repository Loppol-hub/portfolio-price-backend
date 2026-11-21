// ฟังก์ชันคำนวณข้อมูลพอร์ตฝั่งเซิร์ฟเวอร์ (ปรับลดขนาดข้อมูลเพื่อป้องกันโควต้าเต็ม)
function processPortfolioData(portfolio) {
  if (!portfolio) {
    return { status: 'พอร์ตว่างเปล่า' };
  }

  const holdings = Array.isArray(portfolio.holdings) ? portfolio.holdings : [];
  const rawTradeLogs = Array.isArray(portfolio.tradeLogs) ? portfolio.tradeLogs : [];
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const tradeLogs = rawTradeLogs.filter(l => l && l.date && new Date(l.date) >= oneYearAgo);

  const cashLedger = Array.isArray(portfolio.cashLedger) ? portfolio.cashLedger : [];
  const yearlyHistory = Array.isArray(portfolio.yearlyHistory) ? portfolio.yearlyHistory : [];
  const initialCapital = parseFloat(portfolio.initialCapital) || 0;
  const fxRate = parseFloat(portfolio.fxRate) || 36.5;

  let totalInvestedValue = 0;
  let totalInvestedCost = 0;
  const typeValues = {};
  const industryValues = {};
  let usdAssetsValue = 0;

  const enrichedHoldings = holdings.map(h => {
    const qty = parseFloat(h?.quantity) || 0;
    const avg = parseFloat(h?.avgCost) || 0;
    const price = parseFloat(h?.currentPrice) || 0;
    const currency = h?.currency === 'USD' ? 'USD' : 'THB';
    const isDr = h?.instrumentType === 'dr';

    const effRate = (currency === 'USD' && !isDr) ? fxRate : 1;
    const marketValue = qty * price * effRate;
    
    const fixedRate = (currency === 'USD' && !isDr) ? (parseFloat(h?.createdFxRate) || fxRate) : 1;
    const costValue = h?.totalCostThb !== undefined && h?.totalCostThb !== null 
      ? parseFloat(h.totalCostThb) 
      : (qty * avg * fixedRate);

    const gain = marketValue - costValue;
    const gainPct = costValue > 0 ? (gain / costValue) * 100 : 0;

    if (h?.type !== 'cash') {
      totalInvestedValue += marketValue;
      totalInvestedCost += costValue;
      
      const typeKey = (h?.type === 'th_stock' && h?.instrumentType === 'dr') ? 'foreign_stock' : (h?.type || 'other');
      typeValues[typeKey] = (typeValues[typeKey] || 0) + marketValue;

      const ind = (h?.industry && typeof h.industry === 'string' && h.industry.trim()) || 'อื่นๆ';
      industryValues[ind] = (industryValues[ind] || 0) + marketValue;

      if (currency === 'USD' && !isDr) {
        usdAssetsValue += marketValue;
      }
    }

    // ส่งเฉพาะข้อมูลสรุปสั้นๆ ของแต่ละตัว ไม่ส่ง Object ดิบทั้งหมดเพื่อประหยัด Token
    return {
      name: h.name,
      ticker: h.ticker,
      type: h.type,
      qty,
      avg,
      price,
      marketValue: Math.round(marketValue),
      gainPct: parseFloat(gainPct.toFixed(2))
    };
  });

  const capitalAdd = cashLedger.filter(e => e && e.type === 'capital_add').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const capitalReduce = cashLedger.filter(e => e && e.type === 'capital_reduce').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const capitalAdj = capitalAdd - capitalReduce;
  const totalCapital = initialCapital + capitalAdj;

  const profits = cashLedger.filter(e => e && e.type === 'profit').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const losses = cashLedger.filter(e => e && (e.type === 'loss' || e.type === 'fee')).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const dividends = cashLedger.filter(e => e && e.type === 'dividend').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const rebalances = cashLedger.filter(e => e && e.type === 'rebalance').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

  const performanceTotal = profits - losses;
  const cashAdj = performanceTotal + dividends + rebalances;
  const computedCash = totalCapital - totalInvestedCost + cashAdj;
  const totalAssetValue = totalInvestedValue + computedCash;

  const totalGain = totalInvestedValue - totalInvestedCost;
  const totalGainPct = totalInvestedCost > 0 ? (totalGain / totalInvestedCost) * 100 : 0;

  const currentMonthPrefix = new Date().toISOString().slice(0, 7);
  const currentMonthLogs = tradeLogs.filter(l => l && l.date && typeof l.date === 'string' && l.date.startsWith(currentMonthPrefix));
  
  return {
    totalAssetValue: Math.round(totalAssetValue),
    totalInvestedValue: Math.round(totalInvestedValue),
    totalInvestedCost: Math.round(totalInvestedCost),
    computedCash: Math.round(computedCash),
    totalGain: Math.round(totalGain),
    totalGainPct: parseFloat(totalGainPct.toFixed(2)),
    totalCapital: Math.round(totalCapital),
    fxRate,
    holdingsCount: enrichedHoldings.length,
    typeBreakdown: typeValues,
    industryBreakdown: industryValues,
    usdExposurePct: parseFloat((totalAssetValue > 0 ? (usdAssetsValue / totalAssetValue) * 100 : 0).toFixed(2)),
    cashRatioPct: parseFloat((totalInvestedValue > 0 ? (computedCash / totalInvestedValue) * 100 : 0).toFixed(2)),
    currentMonthSummary: {
      month: currentMonthPrefix,
      totalTransactions: currentMonthLogs.length,
    },
    holdings: enrichedHoldings,
    yearlyHistory: yearlyHistory.length > 0 ? yearlyHistory.slice(-3) : null
  };
}
