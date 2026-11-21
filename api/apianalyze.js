// apianalyze.js - Backend สำหรับประมวลผล AI ผู้ช่วยนักบินอวกาศ (รองรับคำนวณพอร์ตอัตโนมัติและระบบเวลาไทย)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, portfolio, userMessage, customPrompt, fileContent } = req.body;

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
      return res.status(200).json({ analysis: '⚠️ ระบบหลังบ้านยังไม่ได้ตั้งค่า GEMINI_API_KEY บน Vercel ครับ' });
    }

    // 1. ดึงวันที่และเวลาปัจจุบัน เขตเวลา Asia/Bangkok
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('th-TH', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit'
    });
    const currentTimeStr = formatter.format(now);

    // 2. คำนวณตัวเลขพอร์ตจากฝั่งโค้ดหลังบ้านเอง (ป้องกัน AI คำนวณผิดและช่วยประหยัด Token)
    const calculatedPortfolio = processPortfolioData(portfolio);

    // 3. กำหนดกฎการตอบ
    let systemInstruction = `
คุณคือผู้ช่วยอัจฉริยะด้านการลงทุน โทนเสียงกระชับ เป็นมืออาชีพ ตรงประเด็น "ขอเนื้อๆ ไม่เอาน้ำ"
วันที่และเวลาปัจจุบัน (Asia/Bangkok): ${currentTimeStr} (ห้ามเดาวันที่เอง)

กฎเหล็กเคร่งครัด:
1. ห้ามใส่คำทักทายซ้ำซาก หรือเล่นบทบาทสมมติซ้ำซ้อนในทุกครั้งที่กดปุ่ม คำทักทายให้มีเฉพาะตอนเปิดแชทครั้งแรกเท่านั้น
2. ห้ามสาธยายรายชื่อหุ้นและจำนวนหุ้นทีละตัวแบบเยิ่นเย้อ ให้สรุปวิเคราะห์เป็นภาพรวมตามหมวดหมู่สินทรัพย์ เว้นแต่ผู้ใช้จะถามเจาะจง
3. ห้ามแต่งข้อมูล ตัวเลข หรือสร้างข่าวเท็จขึ้นมาเองเด็ดขาด (No Hallucination)
4. ตัวเลขและสัดส่วนต่างๆ ของพอร์ตให้ยึดตามที่ระบบคำนวณมาให้ใน "ข้อมูลพอร์ตที่คำนวณแล้ว" เท่านั้น ห้ามคำนวณใหม่เอง
5. หากข้อมูลประวัติปีก่อนหรือเดือนก่อนเป็นค่า null ให้ตอบตามตรงว่า "ยังไม่มีข้อมูลเปรียบเทียบ" ห้ามคาดเดาเอง
    `.trim();

    if (customPrompt) {
      systemInstruction += `\n\nกติกาเพิ่มเติมจากผู้ใช้:\n${customPrompt}`;
    }

    let fileContext = fileContent ? `\n\n[ข้อมูลอ้างอิงจากไฟล์]:\n${fileContext}` : '';

    // 4. ปรับแต่งโครงสร้างคำสั่งของแต่ละปุ่ม
    let contextPrompt = '';
    
    switch (action) {
      case 'greeting':
        contextPrompt = 'ทักทายต้อนรับเข้าห้องแชทสั้นๆ และสรุปสุขภาพพอร์ตภาพรวมแบบกระชับ (มูลค่ารวม, กำไร/ขาดทุน, สัดส่วนเงินสด)';
        break;

      case 'deep_analysis':
        contextPrompt = `วิเคราะห์พอร์ตการลงทุนเชิงลึก โดยอิงตามสัดส่วนเป้าหมายที่ผู้ใช้ตั้งไว้ ให้ตอบตาม 3 หัวข้อนี้เท่านั้น:
        1. สัดส่วนสินทรัพย์ปัจจุบัน (เทียบภาพรวมแต่ละกลุ่มกับเป้าหมายจากข้อมูลที่คำนวณแล้ว)
        2. การกระจายตัวและความเสี่ยงของพอร์ต
        3. คำแนะนำว่าสินทรัพย์กลุ่มไหนมีสัดส่วนมากหรือน้อยเกินไป และควรปรับเพิ่มหรือลดกลุ่มไหน`;
        break;

      case 'portfolio_summary':
        contextPrompt = 'สรุปภาพรวมผลตอบแทนประจำเดือนนี้: อัตรากำไร/ขาดทุนรวมจากเงินต้นทั้งหมด, การเติบโตเทียบกับเดือนก่อนหน้าหรือปีก่อน (ตามข้อมูลที่มี ถ้าไม่มีให้แจ้งว่ายังไม่มีข้อมูล) และสรุปการซื้อขายแบบกระชับ';
        break;

      case 'asset_analysis':
        contextPrompt = `วิเคราะห์สินทรัพย์ตามที่ผู้ใช้ระบุ: "${userMessage}" เน้นมุมมองแนวโน้ม กลยุทธ์ แนวรับ แนวต้าน หรือข้อมูลบริษัทแม่ (กรณี DR) แบบกระชับ`;
        break;

      case 'news_analysis':
        contextPrompt = `วิเคราะห์ผลกระทบของสถานการณ์/ข่าวต่อพอร์ต: "${userMessage}" สรุปผลกระทบและแนวทางรับมือสั้นๆ พร้อมระบุแหล่งที่มา`;
        break;

      case 'chat':
      default:
        contextPrompt = userMessage || 'ให้คำปรึกษาทั่วไปเกี่ยวกับการลงทุนแบบกระชับ ตรงประเด็น';
        break;
    }

    const fullUserPrompt = `
ข้อมูลพอร์ตที่คำนวณแล้ว: ${JSON.stringify(calculatedPortfolio)}
${fileContext}

คำสั่ง: ${contextPrompt}
    `.trim();

    // 5. เรียกใช้งาน Gemini API
    const modelName = 'gemini-3.5-flash-lite';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: `${systemInstruction}\n\n${fullUserPrompt}` }] }
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1000,
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const data = await response.json();

    if (data.error) {
      return res.status(200).json({ 
        analysis: `⚠️ Google API Error: ${data.error.message || JSON.stringify(data.error)}` 
      });
    }

    const aiReply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'สัญญาณจากฐานทัพขาดหาย ไม่ได้รับข้อมูลตอบกลับครับ';
    return res.status(200).json({ analysis: aiReply });

  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(200).json({ 
        analysis: '⚠️ เซิร์ฟเวอร์ใช้เวลาตอบกลับนานเกินไป กรุณาลองใหม่อีกครั้งครับ' 
      });
    }
    console.error('[API Error]:', error);
    return res.status(200).json({ 
      analysis: `⚠️ Server Error: ${error.message}` 
    });
  }
}

// ฟังก์ชันคำนวณข้อมูลพอร์ตฝั่งเซิร์ฟเวอร์ (Pre-calculate)
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
  const history = Array.isArray(portfolio.history) ? portfolio.history : [];
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

    return {
      name: h?.name || '',
      ticker: h?.ticker || '',
      type: h?.type || '',
      marketValue: Math.round(marketValue),
      costValue: Math.round(costValue),
      gain: Math.round(gain),
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
  const buyLogs = currentMonthLogs.filter(l => l && l.action === 'buy');
  const sellLogs = currentMonthLogs.filter(l => l && l.action === 'sell');
  
  const totalBuyVal = buyLogs.reduce((s, l) => s + ((parseFloat(l.quantity) || 0) * (parseFloat(l.price) || 0) * (l.currency === 'USD' ? fxRate : 1)), 0);
  const totalSellVal = sellLogs.reduce((s, l) => s + ((parseFloat(l.quantity) || 0) * (parseFloat(l.price) || 0) * (l.currency === 'USD' ? fxRate : 1)), 0);
  const totalMonthFee = currentMonthLogs.reduce((s, l) => s + (parseFloat(l.feeThbRecord) || 0), 0);

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
      buyCount: buyLogs.length,
      sellCount: sellLogs.length,
      totalBuyVal: Math.round(totalBuyVal),
      totalSellVal: Math.round(totalSellVal),
      totalMonthFee: Math.round(totalMonthFee)
    },
    holdings: enrichedHoldings,
    yearlyHistory: yearlyHistory.length > 0 ? yearlyHistory.slice(-3) : null,
    history: history.length > 0 ? history.slice(-6) : null
  };
}
