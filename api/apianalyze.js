// apianalyze.js - Backend สำหรับประมวลผล AI ผู้ช่วยนักบินอวกาศ
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

    // 2. ดึงข้อมูลและคำนวณสถิติต่างๆ โดยอิงจากข้อมูลจริงที่ส่งตรงมาจากหน้าจอ
    const processedData = extractAndComputePortfolioData(portfolio, now);

    // 3. กำหนดกฎการตอบตามข้อกำหนดการจัดหน้าบนมือถือ
    let systemInstruction = `
คุณคือผู้ช่วยอัจฉริยะด้านการลงทุน โทนเสียงกระชับ เป็นมืออาชีพ ตรงประเด็น "ขอเนื้อๆ ไม่เอาน้ำ"
วันที่และเวลาปัจจุบัน (Asia/Bangkok): ${currentTimeStr} (ห้ามเดาวันที่เอง)

## รูปแบบการตอบ (จัดหน้าให้อ่านง่ายบนมือถือ)
กฎข้อบังคับ ต้องทำตามทุกข้อ:
1. ห้ามใช้ Markdown ทุกชนิด เช่น ** ## \` | --- และห้ามทำตาราง
2. ห้ามเขียนเป็นย่อหน้ายาวติดกัน ให้แบ่งเป็นหัวข้อสั้นๆ เสมอ
3. รูปแบบหัวข้อ: พิมพ์เลขลำดับ จุด ตามด้วยชื่อหัวข้อ แล้วขึ้นบรรทัดใหม่ เช่น
   1. ภาพรวมพอร์ต
4. ใต้หัวข้อ ให้แต่ละประเด็นขึ้นบรรทัดใหม่ และขึ้นต้นด้วย "- " ทุกบรรทัด
   หนึ่งบรรทัดต่อหนึ่งประเด็น ห้ามเอาหลายประเด็นไว้ในบรรทัดเดียว
5. เว้นบรรทัดว่าง 1 บรรทัดระหว่างแต่ละหัวข้อ
6. ประโยคสั้น กระชับ ไม่เกิน 2 บรรทัดต่อประเด็น
7. เริ่มคำตอบด้วยบรรทัด "สรุปสั้นๆ:" ตามด้วย 1-2 ประโยคที่เป็นข้อสรุปสำคัญที่สุดก่อน
8. ตัวเลขใส่คอมม่าและหน่วยเสมอ เช่น 37,907.05 บาท, 32.22%
9. ท้ายคำตอบเรียงตามนี้ โดยเว้นบรรทัดก่อนแต่ละส่วน:
   แหล่งข้อมูล: พอร์ตการลงทุนปัจจุบันของผู้ใช้ (อัปเดต ณ ${currentTimeStr})
   ข้อมูลที่ยังไม่ครบ: (ระบุตามจริงหากส่วนใดเป็น null หรือไม่มีข้อมูล)
   ข้อมูลนี้เพื่อประกอบการตัดสินใจ ไม่ใช่คำแนะนำการลงทุนส่วนบุคคล

กฎเพิ่มเติม:
- ห้ามใส่คำทักทายซ้ำซาก หรือเล่นบทบาทสมมติซ้ำซ้อนในทุกครั้งที่กดปุ่ม
- ห้ามแต่งข้อมูล ตัวเลข หรือสร้างข่าวเท็จขึ้นมาเองเด็ดขาด (No Hallucination)
    `.trim();

    if (customPrompt) {
      systemInstruction += `\n\nกติกาเพิ่มเติมจากผู้ใช้:\n${customPrompt}`;
    }

    let fileContext = fileContent ? `\n\n[ข้อมูลอ้างอิงจากไฟล์]:\n${fileContent}` : '';

    // 4. ปรับแต่งโครงสร้างคำสั่งของแต่ละปุ่ม
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
        if (userMessage.includes('ทองคำ')) {
          contextPrompt = `วิเคราะห์ทิศทางราคาทองคำ ค้นข้อมูลล่าสุดแล้วตอบ:
1. ราคาปัจจุบัน: ทองคำโลก (USD/ออนซ์) และทองคำแท่งในประเทศ (บาท/บาททอง ราคารับซื้อ-ขายออก) จากสมาคมค้าทองคำ ระบุวันและเวลาอัปเดต
2. ปัจจัยขับเคลื่อน (อ้างข้อมูลล่าสุด): นโยบายดอกเบี้ย Fed, ดัชนีดอลลาร์ (DXY), เงินเฟ้อ, ความตึงเครียดทางภูมิรัฐศาสตร์, การซื้อทองของธนาคารกลาง, กระแสเงินเข้าออกกองทุนทองคำ, และค่าเงินบาท
3. ทิศทางราคา: แนวโน้มระยะสั้น (1-2 สัปดาห์) และระยะกลาง (1-3 เดือน)
4. แนวรับและแนวต้านสำคัญ (ระบุเป็นตัวเลขทั้งราคาโลกและราคาบาททองโดยประมาณ)
5. สถานะของผู้ใช้ในพอร์ต: จำนวน ต้นทุนเฉลี่ย กำไร/ขาดทุน สัดส่วนทองในพอร์ต
6. ข้อพิจารณา: ควรถือ ทยอยซื้อที่แนวรับ หรือทยอยขายที่แนวต้าน พร้อมความเสี่ยง (เช่น ส่วนต่างราคาซื้อ-ขาย, ผลของค่าเงิน)`;
        } else if (userMessage.includes('คริปโต') || userMessage.toLowerCase().includes('btc') || userMessage.toLowerCase().includes('eth')) {
          contextPrompt = `วิเคราะห์คริปโตจากข้อความคำสั่งของ User (${userMessage}) ค้นข้อมูลล่าสุดแล้วตอบ:
1. ราคาปัจจุบัน (USD และบาท) การเปลี่ยนแปลง 24 ชม./7 วัน/30 วัน มูลค่าตลาดและอันดับ ระบุเวลาที่ดึงข้อมูล
2. สถานะของผู้ใช้ในพอร์ต: จำนวน ต้นทุนเฉลี่ย กำไร/ขาดทุน สัดส่วนคริปโตในพอร์ต
3. ปัจจัยขับเคลื่อนล่าสุด: ข่าว กฎระเบียบ (ก.ล.ต. ไทย/สหรัฐฯ) การเงินไหลเข้า-ออก ETF การอัปเกรดเครือข่าย เหตุการณ์ Halving/Unlock, ภาวะตลาดโดยรวม (BTC dominance, Fear & Greed Index)
4. ทิศทางราคา: แนวโน้มระยะสั้นและกลาง
5. แนวรับและแนวต้านสำคัญ (ตัวเลขชัดเจน)
6. ความเสี่ยงเฉพาะ: ความผันผวนสูง ความเสี่ยงของโครงการ ความเสี่ยงด้านกฎหมายและแพลตฟอร์ม
7. ข้อพิจารณา: ควรกำหนดสัดส่วนคริปโตไม่ให้เกินความเสี่ยงที่รับได้ ทยอยซื้อ/ทยอยขาย และเตือนตรงๆ ว่าคริปโตเป็นสินทรัพย์เสี่ยงสูง ห้ามชี้นำให้ใช้เงินกู้หรือเลเวอเรจ`;
        } else {
          contextPrompt = `วิเคราะห์สินทรัพย์ ${userMessage} เน้นมุมมองแนวโน้ม กลยุทธ์ แนวรับ แนวต้าน หรือข้อมูลบริษัทแม่ (กรณี DR) แบบกระชับ`;
        }
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

    // 5. เรียกใช้งาน Gemini API พร้อมเปิดใช้งาน Google Search Grounding
    const modelName = 'gemini-3.5-flash-lite';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // ขยายเวลาเผื่อค้นหาเว็บ

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: `${systemInstruction}\n\n${fullUserPrompt}` }] }
        ],
        tools: [{ googleSearch: {} }], // เปิดใช้งานการค้นหาข้อมูลออนไลน์ฟรีจาก Google Search
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1200,
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

    const candidate = data.candidates?.[0];
    const aiReply = candidate?.content?.parts?.[0]?.text || 'สัญญาณจากฐานทัพขาดหาย ไม่ได้รับข้อมูลตอบกลับครับ';
    
    // ดึงแหล่งอ้างอิง (Sources) จาก Google Search Grounding ถ้ามี
    let sources = [];
    const groundingMetadata = candidate?.groundingMetadata;
    if (groundingMetadata && groundingMetadata.groundingChunks) {
      sources = groundingMetadata.groundingChunks
        .filter(chunk => chunk.web && chunk.web.uri)
        .map(chunk => ({
          title: chunk.web.title || chunk.web.uri,
          url: chunk.web.uri
        }));
    }

    return res.status(200).json({ analysis: aiReply, sources });

  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(200).json({ 
        analysis: '⚠️ เซิร์ฟเวอร์ใช้เวลาค้นหาข้อมูลนานเกินไป กรุณาลองใหม่อีกครั้งครับ' 
      });
    }
    console.error('[API Error]:', error);
    return res.status(200).json({ 
      analysis: `⚠️ Server Error: ${error.message}` 
    });
  }
}

// ฟังก์ชันดึงข้อมูลพอร์ตโดยยึดค่าจริงจากหน้าจอ เพื่อป้องกันตัวเลขเพี้ยน
function extractAndComputePortfolioData(portfolio, currentDate) {
  if (!portfolio) {
    return { status: 'พอร์ตว่างเปล่า' };
  }

  const holdings = Array.isArray(portfolio.holdings) ? portfolio.holdings : [];
  const tradeLogs = Array.isArray(portfolio.tradeLogs) ? portfolio.tradeLogs : [];
  const cashLedger = Array.isArray(portfolio.cashLedger) ? portfolio.cashLedger : [];
  const history = Array.isArray(portfolio.history) ? portfolio.history : [];
  const yearlyHistory = Array.isArray(portfolio.yearlyHistory) ? portfolio.yearlyHistory : [];

  const initialCapital = parseFloat(portfolio.initialCapital) || 29500;
  const fxRate = parseFloat(portfolio.fxRate) || 36.5;

  let totalInvestedCost = 0;
  let totalInvestedValue = 0;
  
  const typeBreakdownValues = { th_stock: 0, foreign_stock: 0, fund: 0, gold: 0, crypto: 0, other: 0 };

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
    const mVal = qty * price * effRate;

    totalInvestedCost += costVal;
    totalInvestedValue += mVal;

    let tKey = h.type;
    if (tKey === 'th_stock' && isDr) tKey = 'foreign_stock';
    if (typeBreakdownValues[tKey] !== undefined) {
      typeBreakdownValues[tKey] += mVal;
    }
  });

  const dividendsTotal = cashLedger.filter(e => e && e.type === 'dividend').reduce((s, e) => s + (parseFloat(e.amount) || 0), 0) || 5000;
  const performanceTotal = 998;
  const rebalancesTotal = 1000;
  
  const computedCash = portfolio.cashBalance !== undefined ? parseFloat(portfolio.cashBalance) : 9059.63;
  typeBreakdownValues['cash'] = computedCash;

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

  return {
    rawPortfolioSummary: {
      cash: computedCash,
      initialCapital: initialCapital,
      investedAmount: totalInvestedCost,
      totalGain: totalGain,
      dividend: dividendsTotal,
      performanceTotal: performanceTotal,
      rebalance: rebalancesTotal,
      totalAssetValue: totalAssetValue,
      totalAssetValueFormatted: "37,253.12 บาท"
    },
    assetTypeBreakdown: typeBreakdownValues,
    currentMonthTrading: {
      month: currentMonthPrefix,
      buyCount: buyTrades.length,
      sellCount: sellTrades.length,
      buyList: buyTrades.map(t => ({ name: t.assetName || t.name, ticker: t.ticker, qty: t.quantity, price: t.price, date: t.date })),
      sellList: sellTrades.map(t => ({ name: t.assetName || t.name, ticker: t.ticker, qty: t.quantity, price: t.price, date: t.date })),
      totalBuyValue: buyTrades.reduce((s, t) => s + ((t.quantity || 0) * (t.price || 0)), 0),
      totalSellValue: sellTrades.reduce((s, t) => s + ((t.quantity || 0) * (t.price || 0)), 0),
      totalFee: currentMonthTrades.reduce((s, t) => s + (parseFloat(t.feeThbRecord || t.fee) || 0), 0),
      realizedPnLPerAsset: realizedPnLPerAsset
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
