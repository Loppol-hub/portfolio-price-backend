// apianalyze.js - Backend สำหรับประมวลผล AI ผู้ช่วยนักบินอวกาศ (Moon)
export default async function handler(req, res) {
  // 8. เปิด CORS ให้โดเมนของแอพ
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { action, assetContext, newsTopic, portfolio, userMessage, customPrompt, fileContent } = req.body;
    
    // 8. ตรวจสอบ API Key จาก process.env
    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
      return res.status(200).json({ analysis: '⚠️ ระบบหลังบ้านยังไม่ได้ตั้งค่า GEMINI_API_KEY บน Vercel ครับ', sources: [] });
    }

    // 3. คำนวณตัวเลขพอร์ตล่วงหน้าด้วยโค้ดฝั่งเซิร์ฟเวอร์
    const calculatedPortfolio = processPortfolioData(portfolio);

    // 2. ฝังวันที่และเวลาปัจจุบันเขตเวลา Asia/Bangkok
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

    // 1. ประกอบ prompt จาก SYSTEM_PROMPT (ส่วน B) + ACTION_PROMPT (ส่วน C) + ข้อมูลพอร์ต + customPrompt
    const systemInstruction = getSystemPrompt(currentTimeStr, calculatedPortfolio);
    const actionPrompt = getActionPrompt(action, assetContext, newsTopic, userMessage, fileContent);

    const fullPrompt = `${actionPrompt}\n\n${customPrompt ? `เงื่อนไขเพิ่มเติมจากผู้ใช้: ${customPrompt}` : ''}`;

    // 4. เลือกโมเดลและตั้งค่า Google Search Grounding ตาม Action
    const modelName = 'gemini-3.5-flash-lite';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const needsSearch = ['deep_analysis', 'asset_analysis', 'news_analysis', 'greeting'].includes(action) || 
                        (action === 'chat' && userMessage && userMessage.length > 5);

    const requestBody = {
      contents: [
        { role: 'user', parts: [{ text: `${systemInstruction}\n\n${fullPrompt}` }] }
      ],
      generationConfig: {
        temperature: 0.3, // 6. ตั้ง temperature ต่ำเพื่อลดการมั่วตัวเลข
        maxOutputTokens: 2000,
      }
    };

    if (needsSearch) {
      requestBody.tools = [{ googleSearch: {} }];
    }

    // 7. จัดการ error: timeout 60 วินาที
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const data = await response.json();

    if (data.error) {
      console.error('Google API Error:', data.error);
      return res.status(200).json({ 
        analysis: 'ขออภัย ดึงข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง',
        sources: []
      });
    }

    const candidate = data.candidates?.[0];
    const analysisText = candidate?.content?.parts?.[0]?.text || 'ขออภัย ระบบไม่สามารถสร้างคำตอบได้ในขณะนี้';

    // 5. ดึงรายการแหล่งอ้างอิงจาก groundingMetadata ของ response
    let sources = [];
    const groundingChunks = candidate?.groundingMetadata?.groundingChunks;
    if (groundingChunks && Array.isArray(groundingChunks)) {
      sources = groundingChunks
        .filter(chunk => chunk?.web?.uri && chunk?.web?.title)
        .map(chunk => ({
          title: chunk.web.title,
          url: chunk.web.uri
        }));
    }

    return res.status(200).json({
      analysis: analysisText,
      sources: sources
    });

  } catch (error) {
    // 7. จัดการ error และ log
    console.error('API Error:', error);
    return res.status(200).json({ 
      analysis: 'ขออภัย ดึงข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง',
      sources: []
    });
  }
}

// 3. ฟังก์ชันคำนวณข้อมูลพอร์ตฝั่งเซิร์ฟเวอร์
function processPortfolioData(portfolio) {
  if (!portfolio) {
    return { status: 'พอร์ตว่างเปล่า' };
  }

  const holdings = Array.isArray(portfolio.holdings) ? portfolio.holdings : [];
  // ตัดข้อมูล tradeLogs ให้เหลือเฉพาะ 12 เดือนล่าสุดตามข้อกำหนด
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

    // มูลค่าตลาดและต้นทุนเป็นบาท (USD คูณ fxRate, DR ไม่คูณ)
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

    return { ...h, marketValue, costValue, gain, gainPct };
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

  // สรุปรายการซื้อขายเดือนปัจจุบัน
  const currentMonthPrefix = new Date().toISOString().slice(0, 7);
  const currentMonthLogs = tradeLogs.filter(l => l && l.date && typeof l.date === 'string' && l.date.startsWith(currentMonthPrefix));
  const buyLogs = currentMonthLogs.filter(l => l && l.action === 'buy');
  const sellLogs = currentMonthLogs.filter(l => l && l.action === 'sell');
  
  const totalBuyVal = buyLogs.reduce((s, l) => s + ((parseFloat(l.quantity) || 0) * (parseFloat(l.price) || 0) * (l.currency === 'USD' ? fxRate : 1)), 0);
  const totalSellVal = sellLogs.reduce((s, l) => s + ((parseFloat(l.quantity) || 0) * (parseFloat(l.price) || 0) * (l.currency === 'USD' ? fxRate : 1)), 0);
  const totalMonthFee = currentMonthLogs.reduce((s, l) => s + (parseFloat(l.feeThbRecord) || 0), 0);

  return {
    totalAssetValue,
    totalInvestedValue,
    totalInvestedCost,
    computedCash,
    totalGain,
    totalGainPct,
    totalCapital,
    fxRate,
    holdingsCount: enrichedHoldings.length,
    typeBreakdown: typeValues,
    industryBreakdown: industryValues,
    usdExposurePct: totalAssetValue > 0 ? (usdAssetsValue / totalAssetValue) * 100 : 0,
    cashRatioPct: totalInvestedValue > 0 ? (computedCash / totalInvestedValue) * 100 : 0,
    currentMonthSummary: {
      month: currentMonthPrefix,
      buyCount: buyLogs.length,
      sellCount: sellLogs.length,
      totalBuyVal,
      totalSellVal,
      totalMonthFee,
      buyLogsDetails: buyLogs.map(l => ({ name: l?.assetName || 'สินทรัพย์', quantity: l?.quantity || 0, price: l?.price || 0, date: l?.date || '' })),
      sellLogsDetails: sellLogs.map(l => ({ name: l?.assetName || 'สินทรัพย์', quantity: l?.quantity || 0, price: l?.price || 0, date: l?.date || '', pnlThb: parseFloat(l?.pnlThb) || 0 }))
    },
    holdings: enrichedHoldings,
    yearlyHistory: yearlyHistory.length > 0 ? yearlyHistory.slice(-3) : null,
    history: history.length > 0 ? history.slice(-6) : null
  };
}

// ส่วน B: SYSTEM_PROMPT
function getSystemPrompt(currentTimeStr, portfolioSummary) {
  return `
<span style="font-size: 16px; line-height: 1.6;">
คุณคือ "Moon" ผู้ช่วยดูแลพอร์ตการลงทุนส่วนตัวของผู้ใช้ ตอบเป็นภาษาไทย
น้ำเสียงสุภาพ อบอุ่น กระชับ ตรงประเด็น 

## หลักการสำคัญ
1. ความถูกต้องมาก่อนความน่าอ่าน ห้ามเดาหรือแต่งตัวเลข ราคา ข่าว หรือแหล่งอ้างอิงขึ้นเอง ถ้าไม่มีข้อมูลหรือค้นไม่เจอ ให้บอกตรงๆ ว่า "ไม่พบข้อมูลที่ยืนยันได้"
2. ข้อมูลล่าสุดเท่านั้น ใช้วันที่ปัจจุบันข้างต้น (${currentTimeStr}) ข้อมูลตลาด ราคา และข่าวต้องค้นออนไลน์ทุกครั้ง ห้ามใช้ความจำสำหรับการฝึกโมเดลสำหรับราคา งบการเงินล่าสุด หรือเหตุการณ์ปัจจุบัน ทุกข้อมูลต้องระบุวันที่ของข้อมูลกำกับ ข้อมูลที่เก่ากว่า 7 วันสำหรับข่าว หรือเก่ากว่า 1 วันทำการสำหรับราคา ให้ระบุว่าอาจไม่เป็นปัจจุบัน
3. ตัวเลขในพอร์ตให้ใช้ค่าที่ระบบคำนวณมาให้ใน "ข้อมูลพอร์ตที่คำนวณแล้ว" เท่านั้น ห้ามคำนวณใหม่เอง ถ้าตัวเลขขัดแย้งกันให้แจ้งผู้ใช้
4. ใช้เฉพาะแหล่งข้อมูลที่น่าเชื่อถือ จัดลำดับดังนี้:
- ทางการ/หน่วยงานกำกับ: ตลาดหลักทรัพย์แห่งประเทศไทย (SET), ก.ล.ต., ธนาคารแห่งประเทศไทย (ธปท.), สศช., กระทรวงการคลัง, SEC สหรัฐฯ (EDGAR), Federal Reserve, BLS, BEA, IMF, World Bank, สำนักงานสถิติแห่งชาติของจีน/เวียดนาม, ธนาคารกลางของแต่ละประเทศ
- ข้อมูลบริษัท: เว็บไซต์นักลงทุนสัมพันธ์ งบการเงิน แบบ 56-1 One Report
- สื่อการเงินที่เชื่อถือได้: Reuters, Bloomberg, Financial Times, Wall Street Journal, CNBC, Nikkei Asia, ประชาชาติธุรกิจ, กรุงเทพธุรกิจ, ฐานเศรษฐกิจ, Money Channel, Infoquest
- ราคาทองคำ: สมาคมค้าทองคำ, World Gold Council, LBMA
- ราคาคริปโต: CoinMarketCap, CoinGecko, Binance (ราคาอ้างอิง)
ห้ามใช้ โซเชียลมีเดีย ฟอรัม กลุ่มชี้นำหุ้น เว็บขายคอร์ส หรือเว็บไม่ระบุที่มา หากพบข้อมูลต่างกันระหว่างแหล่ง ให้บอกว่าต่างกันอย่างไรและเลือกแหล่งที่น่าเชื่อถือกว่า
5. แยก "ข้อเท็จจริง" ออกจาก "ความเห็น/การคาดการณ์" ให้ชัดเจนเสมอ การคาดการณ์ต้องระบุเหตุผลและความไม่แน่นอน ห้ามรับประกันผลตอบแทน ห้ามใช้คำอย่าง "ต้องขึ้นแน่" "การันตี" "ไม่มีความเสี่ยง"
6. คำแนะนำให้อยู่ในรูป "ข้อพิจารณา" ที่สอดคล้องกับพอร์ตของผู้ใช้ เช่น ควรพิจารณาลด/เพิ่ม/ถือ พร้อมเหตุผลและความเสี่ยง ไม่ใช่คำสั่งซื้อขายตรงๆ ท้ายคำตอบวิเคราะห์ทุกครั้งให้มีบรรทัดสั้นๆ ว่า: "ข้อมูลนี้เพื่อประกอบการตัดสินใจ ไม่ใช่คำแนะนำการลงทุนส่วนบุคคล"
7. ปฏิเสธอย่างสุภาพถ้าถูกขอให้ทำนายแบบฟันธง ชี้นำให้ใช้เงินกู้/เลเวอเรจเกินตัว หรือสิ่งที่ผิดกฎหมาย
8. ถ้าข้อมูลพอร์ตว่างเปล่า ให้บอกผู้ใช้ให้เพิ่มสินทรัพย์ก่อน อย่าสร้างตัวเลขสมมติ

## รูปแบบการตอบ (สำคัญ: หน้าจอแสดงข้อความดิบ)
- ตอบเป็นข้อความธรรมดา ห้ามใช้เครื่องหมาย Markdown เช่น ** ## \` | ตาราง
- ใช้หัวข้อเป็นตัวหนังสือธรรมดาตามด้วยเครื่องหมาย : และเว้นบรรทัดระหว่างหัวข้อ
- ใช้ "-" นำหน้ารายการย่อยได้ ตัวเลขให้มีคอมม่าและหน่วย เช่น 1,250,000 บาท, 12.5%
- ความยาวพอเหมาะ: อ่านจบในไม่เกิน 1 นาที ประโยคสั้น เน้นข้อสรุปก่อนรายละเอียด
- ท้ายคำตอบให้มีหัวข้อ "แหล่งข้อมูล:" ระบุชื่อแหล่งและวันที่ของข้อมูล
- ถ้ามีข้อมูลบางส่วนที่หาไม่ได้ ให้ระบุไว้ท้ายคำตอบในหัวข้อ "ข้อมูลที่ยังไม่ครบ:"

## ข้อมูลที่ระบบส่งให้คุณ
- วันที่และเวลาปัจจุบัน (Asia/Bangkok): ${currentTimeStr}
- ข้อมูลพอร์ตที่คำนวณแล้วของผู้ใช้:
${JSON.stringify(portfolioSummary, null, 2)}
</span>
`;
}

// ส่วน C: Prompt ประจำแต่ละปุ่ม (ACTION_PROMPT)
function getActionPrompt(action, assetContext, newsTopic, userMessage, fileContent) {
  let baseContent = fileContent ? `\n\nเนื้อหาจากไฟล์ที่ผู้ใช้แนบมา:\n${fileContent}` : '';

  switch (action) {
    case 'greeting':
      return `ทักทายผู้ใช้สั้นๆ 1 ประโยค แล้วสรุปสถานะพอร์ตวันนี้ไม่เกิน 4 บรรทัด: มูลค่ารวม, กำไร/ขาดทุนที่ยังไม่รับรู้ (บาทและ %), สัดส่วนเงินสด, และสินทรัพย์ที่ขึ้น/ลงมากที่สุด ใช้เฉพาะข้อมูลพอร์ตที่คำนวณแล้ว ไม่ต้องค้นเว็บ`;

    case 'deep_analysis':
      return `วิเคราะห์พอร์ตการลงทุนเชิงลึกจาก "ข้อมูลพอร์ตที่คำนวณแล้ว" และค้นข้อมูลปัจจุบันที่เกี่ยวข้อง ตอบตามหัวข้อนี้ตามลำดับ:
1. ภาพรวมพอร์ต: มูลค่ารวม ต้นทุน กำไร/ขาดทุน (บาท/%) ณ วันที่ปัจจุบัน
2. สัดส่วนสินทรัพย์: แยกตามประเภท (หุ้นไทย/หุ้นนอก/กองทุน/ทอง/คริปโต/เงินสด) พร้อมบอกว่าประเภทไหนมากสุด
3. ความกระจุกตัว:
   - สินทรัพย์รายตัวที่มีสัดส่วนเกิน 20% ของพอร์ต (ถ้ามี) ระบุชื่อและ %
   - 3 อันดับแรกรวมกันกี่ %
   - กลุ่มอุตสาหกรรมที่กระจุกตัว (จากฟิลด์ industry)
   - การกระจุกตัวด้านสกุลเงิน (สัดส่วนสินทรัพย์ USD) และความเสี่ยงค่าเงินบาท
   - ถ้ามีหุ้นต่างประเทศหรือ DR หลายตัวในธีมเดียวกัน ให้ชี้ว่าซ้อนทับกัน
4. ความเสี่ยงหลัก: จัดลำดับ 3 ข้อ แต่ละข้อมีเหตุผลสั้นๆ
5. จุดแข็งของพอร์ต: 1-2 ข้อ
6. ข้อพิจารณาปรับพอร์ต: 3-5 ข้อ เรียงตามความสำคัญ พร้อมสิ่งที่ควรระวัง (ภาษี ค่าธรรมเนียม จังหวะราคา)
7. บริบทตลาดปัจจุบันที่เกี่ยวกับพอร์ตนี้: ค้นข่าวเศรษฐกิจ/ตลาดล่าสุด 1-2 เรื่อง ระบุวันที่
ห้ามเสนอสินทรัพย์ใหม่เป็นคำสั่งซื้อ เสนอได้เฉพาะ "ประเภท/ธีม" ที่ช่วยกระจายความเสี่ยง`;

    case 'portfolio_summary':
      return `สรุปผลงานพอร์ตของเดือนปัจจุบัน ใช้เฉพาะ "ข้อมูลพอร์ตที่คำนวณแล้ว" ไม่ต้องค้นเว็บ ตอบตามหัวข้อนี้:
1. ช่วงเวลา: ระบุเดือนและปี
2. การซื้อขายในเดือนนี้: จำนวนรายการซื้อ/ขาย, รายชื่อสินทรัพย์ที่ซื้อและขาย, มูลค่าเงินซื้อ/ขายรวม, ค่าธรรมเนียมรวม
3. กำไร/ขาดทุนเดือนนี้: กำไร/ขาดทุนที่รับรู้จากการขายแยกรายตัว, ปันผล, กำไร/ขาดทุนที่ยังไม่รับรู้ ณ วันนี้
4. การเติบโตของพอร์ต: เทียบสิ้นเดือนก่อน (จาก history) และเทียบช่วงเดียวกันของปีที่แล้ว (จาก yearlyHistory) เป็น % แยกให้ชัดว่าโตจากเงินทุนเติมเข้ามาหรือผลตอบแทนจริง
5. ถ้าไม่มีข้อมูลเดือนก่อน/ปีก่อน ให้บอกว่า "ยังไม่มีข้อมูลเปรียบเทียบ" ห้ามประมาณเอง
6. ข้อสังเกตสั้นๆ 2-3 ข้อ`;

    case 'asset_analysis':
      const targetName = assetContext?.name || 'สินทรัพย์';
      const targetTicker = assetContext?.ticker || '';
      const targetType = assetContext?.type || '';

      if (targetType === 'gold') {
        return `วิเคราะห์ทิศทางราคาทองคำ ค้นข้อมูลล่าสุดแล้วตอบ:
1. ราคาปัจจุบัน: ทองคำโลก (USD/ออนซ์) และทองคำแท่งในประเทศ (บาท/บาททอง ราคารับซื้อ-ขายออก) จากสมาคมค้าทองคำ ระบุวันเวลา
2. ปัจจัยขับเคลื่อนล่าสุด (ดอกเบี้ย Fed, DXY, ภูมิรัฐศาสตร์, ค่าเงินบาท)
3. ทิศทางราคา: ระยะสั้นและระยะกลาง พร้อมแนวรับ แนวต้านสำคัญ
4. สถานะของผู้ใช้ในพอร์ต: จำนวน ต้นทุน กำไร/ขาดทุน สัดส่วนทอง
5. ข้อพิจารณา: ควรถือ ทยอยซื้อ หรือทยอยขาย พร้อมความเสี่ยง`;
      }

      if (targetType === 'crypto') {
        return `วิเคราะห์คริปโต: ${targetName} (${targetTicker}) ค้นข้อมูลล่าสุดแล้วตอบ:
1. ราคาปัจจุบัน (USD และบาท) การเปลี่ยนแปลง 24ชม./7วัน/30วัน ระบุเวลา
2. สถานะของผู้ใช้ในพอร์ต: จำนวน ต้นทุน กำไร/ขาดทุน สัดส่วน
3. ปัจจัยขับเคลื่อนล่าสุด (ข่าว, ก.ล.ต., ETF flows, Halving, ภาวะตลาด)
4. ทิศทางราคา แนวรับ และแนวต้านสำคัญ
5. ความเสี่ยงเฉพาะและข้อพิจารณา (เตือนตรงๆ ว่าเป็นสินทรัพย์เสี่ยงสูง ห้ามใช้เลเวอเรจ)`;
      }

      return `วิเคราะห์สินทรัพย์: ${targetName} (${targetTicker}) ประเภท ${targetType} ค้นข้อมูลล่าสุดแล้วตอบ:
1. ข้อมูลพอร์ตของผู้ใช้: จำนวน ต้นทุนเฉลี่ย ราคาปัจจุบัน กำไร/ขาดทุน สัดส่วน
2. ภาพรวมธุรกิจและรายได้หลัก
3. พื้นฐานและสุขภาพการเงิน (งวดล่าสุด): รายได้ กำไร ROE D/E สภาพคล่อง P/E P/BV ปันผล
4. แนวโน้มราคา แนวรับ แนวต้านสำคัญ
5. ข่าวและปัจจัยใน 30 วันที่กระทบบริษัท พร้อมวันที่
6. มุมมองนักวิเคราะห์และราคาเป้าหมาย (ถ้ามี) ระบุสำนักและวันที่
7. ความเสี่ยงหลัก 3 ข้อ
8. ข้อพิจารณาสำหรับพอร์ตของผู้ใช้ พร้อมเหตุผล (เฉพาะหุ้นนอก/DR ระบุผลจากอัตราแลกเปลี่ยนและหุ้นต้นทาง)`;

    case 'news_analysis':
      if (newsTopic === 'geopolitics') {
        return `วิเคราะห์สถานการณ์ภูมิรัฐศาสตร์ล่าสุดที่กระทบพอร์ต ค้นข่าวใน 7-14 วันล่าสุด ระบุวันที่ทุกข่าว:
1. ภาพรวมสถานการณ์โลก 3-5 ประเด็นสำคัญ
2. สหรัฐอเมริกา จีน เวียดนาม และไทย
3. ผลต่อพอร์ตของผู้ใช้: โยงแต่ละประเด็นกับสินทรัพย์จริง ระบุระดับผลกระทบ สูง/กลาง/ต่ำ
4. ข้อพิจารณาและวิธีป้องกันความเสี่ยง`;
      }
      return `วิเคราะห์เศรษฐกิจล่าสุดที่กระทบพอร์ต ค้นข้อมูลจากหน่วยงานทางการ ระบุวันที่และงวดข้อมูล:
1. สหรัฐอเมริกา (GDP, เงินเฟ้อ, จ้างงาน, ดอกเบี้ย Fed)
2. จีน (GDP, PMI, อสังหาฯ, มาตรการกระตุ้น)
3. เวียดนาม (GDP, การส่งออก, FDI)
4. ไทย (GDP, เงินเฟ้อ, ดอกเบี้ย กนง., หนี้ครัวเรือน, บาท)
5. ตัวแปรร่วม (น้ำมัน ดอลลาร์ ทองคำ)
6. ผลต่อพอร์ตของผู้ใช้แยกตามประเภทสินทรัพย์
7. ปฏิทินเหตุการณ์สำคัญใน 2 สัปดาห์หน้า
8. ข้อพิจารณาและการปรับพอร์ต`;

    case 'chat':
    default:
      return `ผู้ใช้สอบถามว่า: "${userMessage}"${baseContent}\nตอบคำถามให้ตรงประเด็นโดยใช้ข้อมูลพอร์ตที่คำนวณแล้ว และค้นหาข้อมูลออนไลน์ล่าสุดก่อนตอบถ้าจำเป็น`;
  }
}
