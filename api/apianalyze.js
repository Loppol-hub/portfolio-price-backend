// apianalyze.js - Backend สำหรับประมวลผล AI ผู้ช่วยนักบินอวกาศ (เชื่อมโยงฟิลด์ตรงกับ Frontend)
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

    // 2. ดึงข้อมูลและคำนวณสถิติต่างๆ จากพอร์ตหลังบ้านให้ตรงกับโครงสร้าง Frontend
    const processedData = extractAndComputePortfolioData(portfolio, now);

    // 3. กำหนดกฎการตอบ (ห้ามใช้ Markdown และบังคับขึ้นบรรทัดใหม่สำหรับรายการย่อย)
    let systemInstruction = `
คุณคือผู้ช่วยอัจฉริยะด้านการลงทุน โทนเสียงกระชับ เป็นมืออาชีพ ตรงประเด็น "ขอเนื้อๆ ไม่เอาน้ำ"
วันที่และเวลาปัจจุบัน (Asia/Bangkok): ${currentTimeStr} (ห้ามเดาวันที่เอง)

กฎเหล็กรูปแบบการตอบ (สำคัญมาก ห้ามฝ่าฝืน):
1. ตอบเป็นข้อความธรรมดาเท่านั้น ห้ามใช้เครื่องหมาย Markdown ใดๆ ทั้งสิ้น เช่น ห้ามใช้ ** (ตัวหนา), ห้ามใช้ ## (หัวข้อ), ห้ามใช้ \` (โค้ด), ห้ามใช้ | (เส้นตาราง) หรือทำตารางเด็ดขาด
2. ใช้หัวข้อเป็นตัวหนังสือธรรมดาตามด้วยเครื่องหมาย : และต้องขึ้นบรรทัดใหม่เสมอ
3. ทุกรายการย่อย (ที่มีเครื่องหมาย - นำหน้า) ต้องขึ้นบรรทัดใหม่ทุกข้อ ห้ามเขียนต่อกันเป็นพืดในบรรทัดเดียว
4. ตัวเลขเงินและเปอร์เซ็นต์ต้องมีคอมม่าและหน่วยชัดเจน (เช่น 1,250,000 บาท, 12.5%)
5. ความยาวพอเหมาะ อ่านจบในไม่เกิน 1 นาที ประโยคสั้น เน้นข้อสรุปก่อนรายละเอียด
6. ห้ามใส่คำทักทายซ้ำซาก หรือเล่นบทบาทสมมติซ้ำซ้อนในทุกครั้งที่กดปุ่ม
7. หากข้อมูลส่วนใดในระบบไม่มีหรือเป็นค่า null ให้ระบุไว้ท้ายคำตอบในบรรทัดสุดท้ายขึ้นต้นด้วยหัวข้อ: ข้อมูลที่ยังไม่ครบ: (ตามด้วยรายการที่ขาดหาย)
    `.trim();

    if (customPrompt) {
      systemInstruction += `\n\nกติกาเพิ่มเติมจากผู้ใช้:\n${customPrompt}`;
    }

    let fileContext = fileContent ? `\n\n[ข้อมูลอ้างอิงจากไฟล์]:\n${fileContext}` : '';

    // 4. ปรับแต่งโครงสร้างคำสั่งของแต่ละปุ่มให้กระชับ ตัดคำฟุ่มเฟือยออก
    let contextPrompt = '';
    
    switch (action) {
      case 'greeting':
        contextPrompt = 'สรุปสถานะพอร์ตวันนี้ไม่เกิน 4 บรรทัด: มูลค่ารวม, กำไร/ขาดทุนที่ยังไม่รับรู้ (บาทและ %), สัดส่วนเงินสด, และสินทรัพย์ที่ขึ้น/ลงมากที่สุด';
        break;

      case 'deep_analysis':
        contextPrompt = `วิเคราะห์พอร์ตการลงทุนเชิงลึก ให้ตอบตามหัวข้อด้วยข้อความธรรมดาและขึ้นบรรทัดใหม่ทุกรายการย่อย:
1. ภาพรวมพอร์ต: มูลค่ารวม ต้นทุน กำไร/ขาดทุน (บาท/%) ณ วันที่ปัจจุบัน
2. สัดส่วนสินทรัพย์: แยกตามประเภท (หุ้นไทย th_stock, หุ้นนอก foreign_stock, กองทุน fund, ทองคำ gold, คริปโต crypto, เงินสด cash) พร้อมระบุประเภทที่มากที่สุด
3. ความกระจุกตัว: 
- สัดส่วนเป้าหมายที่ตั้งไว้ (หุ้นไทย 50%, หุ้นนอก+DR 30%, ทองคำ 10%, คริปโต 10%) หากกลุ่มไหนเกินให้แจ้งเตือน
- สินทรัพย์รายตัวที่มีสัดส่วนเกิน 20% ของพอร์ต (ถ้ามี) ระบุชื่อและ %
- 3 อันดับแรกรวมกันกี่ %
- กลุ่มอุตสาหกรรมที่กระจุกตัว (จากฟิลด์ industry)
- หากมีหุ้นต่างประเทศหรือ DR หลายตัวในธีมเดียวกัน ให้ชี้ว่าซ้อนทับกัน
4. ความเสี่ยงหลัก: จัดลำดับ 3 ข้อ แต่ละข้อมีเหตุผลสั้นๆ (ความเสี่ยงตลาด, สภาพคล่อง, ความผันผวน, ค่าเงิน, ค่าธรรมเนียม)
5. จุดแข็งของพอร์ต: 1-2 ข้อ
6. ข้อพิจารณาปรับพอร์ต: 1-3 ข้อ เรียงตามความสำคัญ แต่ละข้อบอกเหตุผลและสิ่งที่ควรระวัง`;
        break;

      case 'portfolio_summary':
        contextPrompt = `สรุปผลตอบแทนประจำเดือนนี้ โดยอิงจากข้อมูลที่คำนวณมาให้:
1. ช่วงเวลา: ระบุเดือนและปีปัจจุบัน
2. การซื้อขายในเดือนนี้:
- จำนวนรายการซื้อ / จำนวนรายการขาย
- รายชื่อสินทรัพย์ที่ซื้อและที่ขาย (ระบุ ชื่อ, จำนวน, ราคา, วันที่)
- มูลค่าเงินซื้อรวม / มูลค่าเงินขายรวม (บาท)
- ค่าธรรมเนียมรวม (บาท)
3. กำไร/ขาดทุนเดือนนี้:
- กำไร/ขาดทุนที่รับรู้จากการขาย (บาท) แยกรายตัว
4. การเติบโตของพอร์ต:
- เทียบสิ้นเดือนก่อน (จากประวัติ history)
- เทียบช่วงเดียวกันของปีที่แล้ว หรือสิ้นปีที่แล้ว (จาก yearlyHistory) เป็น %
- แยกให้ชัดเจนว่าการเติบโตมาจากเงินทุนที่เติมเข้ามา (capital_add) หรือจากผลตอบแทนจริง
- หากไม่มีข้อมูลเดือนก่อนหรือปีก่อน ให้ระบุว่า "ยังไม่มีข้อมูลเปรียบเทียบ" ห้ามประมาณเอง
5. ข้อสังเกตสั้นๆ 2-3 ข้อ`;
        break;

      case 'asset_analysis':
        contextPrompt = `วิเคราะห์สินทรัพย์ ${userMessage} เน้นมุมมองแนวโน้ม กลยุทธ์ แนวรับ แนวต้าน หรือข้อมูลบริษัทแม่ (กรณี DR) แบบกระชับ`;
        break;

      case 'news_analysis':
        contextPrompt = `วิเคราะห์ผลกระทบของข่าว ${userMessage} ต่อพอร์ต สรุปผลกระทบและแนวทางรับมือสั้นๆ พร้อมระบุแหล่งที่มา`;
        break;

      case 'chat':
      default:
        contextPrompt = userMessage || 'ให้คำปรึกษาทั่วไปเกี่ยวกับการลงทุนแบบกระชับ ตรงประเด็น';
        break;
    }

    const fullUserPrompt = `
ข้อมูลพอร์ตและสถิติที่ประมวลผลแล้ว: ${JSON.stringify(processedData)}
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

// ฟังก์ชันดึงและคำนวณข้อมูลพอร์ตให้ตรงกับโครงสร้าง Frontend (จับคู่ชื่อฟิลด์จริง)
function extractAndComputePortfolioData(portfolio, currentDate) {
  if (!portfolio) {
    return { status: 'พอร์ตว่างเปล่า' };
  }

  const holdings = Array.isArray(portfolio.holdings) ? portfolio.holdings : [];
  const tradeLogs = Array.isArray(portfolio.tradeLogs) ? portfolio.tradeLogs : [];
  const cashLedger = Array.isArray(portfolio.cashLedger) ? portfolio.cashLedger : [];
  const history = Array.isArray(portfolio.history) ? portfolio.history : [];
  const yearlyHistory = Array.isArray(portfolio.yearlyHistory) ? portfolio.yearlyHistory : [];

  const initialCapital = parseFloat(portfolio.initialCapital) || 0;
  const fxRate = parseFloat(portfolio.fxRate) || 36.5;

  // คำนวณเงินสด (computedCash) และตัวเลขการเงินตามหลักการเดียวกับหน้าจอ Frontend
  const capitalAdd = cashLedger.filter(e => e && e.type === 'capital_add').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const capitalReduce = cashLedger.filter(e => e && e.type === 'capital_reduce').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const totalCapital = initialCapital + (capitalAdd - capitalReduce);

  let totalInvestedCost = 0;
  let totalInvestedValue = 0;
  holdings.forEach(h => {
    if (!h || h.type === 'cash') return;
    const qty = parseFloat(h.quantity) || 0;
    const avg = parseFloat(h.avgCost) || 0;
    const price = parseFloat(h.currentPrice) || 0;
    const currency = h.currency === 'USD' ? 'USD' : 'THB';
    const isDr = h.instrumentType === 'dr';
    const effRate = (currency === 'USD' && !isDr) ? fxRate : 1;
    const fixedRate = (currency === 'USD' && !isDr) ? (parseFloat(h.createdFxRate) || fxRate) : 1;
    const costVal = h.totalCostThb !== undefined && h.totalCostThb !== null ? parseFloat(h.totalCostThb) : (qty * avg * fixedRate);
    totalInvestedCost += costVal;
    totalInvestedValue += qty * price * effRate;
  });

  const performanceTotal = cashLedger.filter(e => e && e.type === 'profit').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
    - cashLedger.filter(e => e && (e.type === 'loss' || e.type === 'fee')).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  
  const dividendsTotal = cashLedger.filter(e => e && e.type === 'dividend').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const rebalancesTotal = cashLedger.filter(e => e && e.type === 'rebalance').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const cashAdjTotal = performanceTotal + dividendsTotal + rebalancesTotal;

  const computedCash = portfolio.cashBalance !== undefined ? parseFloat(portfolio.cashBalance) : (totalCapital - totalInvestedCost + cashAdjTotal);
  const totalAssetValue = totalInvestedValue + computedCash;
  const totalGain = totalInvestedValue - totalInvestedCost;

  const year = currentDate.getFullYear();
  const month = String(currentDate.getMonth() + 1).padStart(2, '0');
  const currentMonthPrefix = `${year}-${month}`;

  const currentMonthTrades = tradeLogs.filter(l => l && l.date && typeof l.date === 'string' && l.date.startsWith(currentMonthPrefix));
  const buyTrades = currentMonthTrades.filter(l => l && l.action === 'buy');
  const sellTrades = currentMonthTrades.filter(l => l && l.action === 'sell');

  const realizedPnLPerAsset = {};
  sellTrades.forEach(l => {
    const ticker = l.ticker || l.assetName || 'Unknown';
    const pnl = parseFloat(l.pnlThb || l.pnl || 0);
    realizedPnLPerAsset[ticker] = (realizedPnLPerAsset[ticker] || 0) + pnl;
  });

  const monthCapitalAdd = cashLedger
    .filter(e => e && e.type === 'capital_add' && e.date && e.date.startsWith(currentMonthPrefix))
    .reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);

  return {
    rawPortfolioSummary: {
      cash: computedCash,
      initialCapital: totalCapital,
      investedAmount: totalInvestedCost,
      totalGain: totalGain,
      dividend: dividendsTotal,
      performanceTotal: performanceTotal,
      rebalance: rebalancesTotal,
      totalAssetValue: totalAssetValue
    },
    currentMonthTrading: {
      month: currentMonthPrefix,
      buyCount: buyTrades.length,
      sellCount: sellTrades.length,
      buyList: buyTrades.map(t => ({ name: t.assetName || t.name, ticker: t.ticker, qty: t.quantity, price: t.price, date: t.date })),
      sellList: sellTrades.map(t => ({ name: t.assetName || t.name, ticker: t.ticker, qty: t.quantity, price: t.price, date: t.date })),
      totalBuyValue: buyTrades.reduce((s, t) => s + ((t.quantity || 0) * (t.price || 0)), 0),
      totalSellValue: sellTrades.reduce((s, t) => s + ((t.quantity || 0) * (t.price || 0)), 0),
      totalFee: currentMonthTrades.reduce((s, t) => s + (parseFloat(t.feeThbRecord || t.fee) || 0), 0),
      realizedPnLPerAsset: realizedPnLPerAsset,
      capitalAddedThisMonth: monthCapitalAdd
    },
    holdings: holdings.map(h => ({
      name: h?.name || '',
      ticker: h?.ticker || '',
      type: h?.type || 'other',
      instrumentType: h?.instrumentType || 'stock',
      industry: h?.industry || 'อื่นๆ',
      quantity: h?.quantity || 0,
      avgCost: h?.avgCost || 0,
      currentPrice: h?.currentPrice || 0,
      totalCostThb: h?.totalCostThb || 0
    })),
    history: history.length > 0 ? history.slice(-3) : null,
    yearlyHistory: yearlyHistory.length > 0 ? yearlyHistory.slice(-3) : null
  };
}
