import { GoogleGenAI } from '@google/genai';

export default async function handler(req, res) {
  // ตั้งค่า CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { action, assetContext, newsTopic, portfolio, userMessage, customPrompt, fileContent } = req.body;
    
    // ตรวจสอบ API Key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server configuration error: GEMINI_API_KEY not found' });
    }

    const ai = new GoogleGenAI({ apiKey });

    // 1. คำนวณตัวเลขพอร์ตล่วงหน้าเพื่อความแม่นยำ
    const calculatedPortfolio = processPortfolioData(portfolio);

    // 2. ดึงเวลาปัจจุบัน (Asia/Bangkok)
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

    // 3. ประกอบ System Prompt และ Action Prompt
    const systemInstruction = getSystemPrompt(currentTimeStr, calculatedPortfolio);
    const actionPrompt = getActionPrompt(action, assetContext, newsTopic, userMessage, fileContent);

    const fullPrompt = `${actionPrompt}\n\n${customPrompt ? `เงื่อนไขเพิ่มเติมจากผู้ใช้: ${customPrompt}` : ''}`;

    // 4. เลือกโมเดลและตั้งค่า Grounding (Google Search)
    const modelName = 'gemini-3.5-flash-lite';
    
    const needsSearch = ['deep_analysis', 'asset_analysis', 'news_analysis', 'greeting'].includes(action) || 
                        (action === 'chat' && userMessage && userMessage.length > 5);

    const config = {
      systemInstruction: systemInstruction,
      temperature: 0.3, // ค่าต่ำเพื่อลดการมั่วตัวเลข
    };

    if (needsSearch) {
      config.tools = [{ googleSearch: {} }];
    }

    // 5. เรียก Gemini API
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [fullPrompt],
      config: config,
    });

    const analysisText = response.text || 'ขออภัย ระบบไม่สามารถสร้างคำตอบได้ในขณะนี้';

    // 6. ดึงแหล่งอ้างอิง (Grounding Sources) ถ้ามี
    let sources = [];
    const candidate = response.candidates?.[0];
    const groundingChunks = candidate?.groundingMetadata?.groundingChunks;
    
    if (groundingChunks && Array.isArray(groundingChunks)) {
      sources = groundingChunks
        .filter(chunk => chunk.web?.uri && chunk.web?.title)
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
    console.error('API Error:', error);
    return res.status(500).json({ 
      analysis: '⚠️ เกิดข้อผิดพลาดในการประมวลผลของระบบผู้ช่วย AI ลองใหม่อีกครั้งครับ',
      sources: [],
      error: error.message 
    });
  }
}

// ฟังก์ชันคำนวณข้อมูลพอร์ตฝั่งเซิร์ฟเวอร์
function processPortfolioData(portfolio) {
  if (!portfolio || !portfolio.holdings) {
    return { status: 'พอร์ตว่างเปล่า' };
  }

  const { holdings = [], tradeLogs = [], cashLedger = [], history = [], yearlyHistory = [], initialCapital = 0, fxRate = 36.5 } = portfolio;

  let totalInvestedValue = 0;
  let totalInvestedCost = 0;
  const typeValues = {};
  const industryValues = {};
  let usdAssetsValue = 0;

  const enrichedHoldings = holdings.map(h => {
    const qty = parseFloat(h.quantity) || 0;
    const avg = parseFloat(h.avgCost) || 0;
    const price = parseFloat(h.currentPrice) || 0;
    const currency = h.currency === 'USD' ? 'USD' : 'THB';
    const isDr = h.instrumentType === 'dr';

    const effRate = (currency === 'USD' && !isDr) ? fxRate : 1;
    const marketValue = qty * price * effRate;
    
    const fixedRate = (currency === 'USD' && !isDr) ? (h.createdFxRate || fxRate) : 1;
    const costValue = h.totalCostThb !== undefined && h.totalCostThb !== null 
      ? h.totalCostThb 
      : (qty * avg * fixedRate);

    const gain = marketValue - costValue;
    const gainPct = costValue > 0 ? (gain / costValue) * 100 : 0;

    if (h.type !== 'cash') {
      totalInvestedValue += marketValue;
      totalInvestedCost += costValue;
      
      const typeKey = (h.type === 'th_stock' && h.instrumentType === 'dr') ? 'foreign_stock' : h.type;
      typeValues[typeKey] = (typeValues[typeKey] || 0) + marketValue;

      const ind = (h.industry && h.industry.trim()) || 'อื่นๆ';
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

  const currentMonthPrefix = new Date().toISOString().slice(0, 7);
  const currentMonthLogs = tradeLogs.filter(l => l && l.date && l.date.startsWith(currentMonthPrefix));
  const buyLogs = currentMonthLogs.filter(l => l.action === 'buy');
  const sellLogs = currentMonthLogs.filter(l => l.action === 'sell');
  
  const totalBuyVal = buyLogs.reduce((s, l) => s + ((l.quantity || 0) * (l.price || 0) * (l.currency === 'USD' ? fxRate : 1)), 0);
  const totalSellVal = sellLogs.reduce((s, l) => s + ((l.quantity || 0) * (l.price || 0) * (l.currency === 'USD' ? fxRate : 1)), 0);
  const totalMonthFee = currentMonthLogs.reduce((s, l) => s + (l.feeThbRecord || 0), 0);

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
      sellLogsDetails: sellLogs.map(l => ({ name: l.assetName, pnlThb: l.pnlThb || 0 }))
    },
    holdings: enrichedHoldings,
    yearlyHistory: yearlyHistory.slice(-3),
    history: history.slice(-6)
  };
}

// System Prompt (ปรับปรุงใหม่: ห้ามทักทายซ้ำซาก, ตอบกระชับ, ขยายขนาดตัวหนังสือด้วย HTML tag, อนุญาตค้นหาเว็บ)
function getSystemPrompt(currentTimeStr, portfolioSummary) {
  return `
คุณคือผู้ช่วยดูแลพอร์ตการลงทุนส่วนตัวของผู้ใช้ ตอบเป็นภาษาไทย
น้ำเสียงสุภาพ กระชับ ตรงประเด็น "ขอเนื้อๆ ไม่เอาน้ำ"
เวลาปัจจุบัน: ${currentTimeStr}

## กฎเหล็กเคร่งครัด
1. ห้ามใส่คำทักทายซ้ำซาก (เช่น สวัสดีครับนักเดินทาง หรือยินดีต้อนรับสู่ห้องนักบิน) ในการกดปุ่มหรือส่งข้อความระหว่างการสนทนา คำทักทายให้มีเฉพาะตอนเปิดหน้าต่างแชทครั้งแรกเท่านั้น
2. ห้ามสาธยายรายชื่อหุ้นและจำนวนหุ้นทีละตัวแบบเยิ่นเย้อ ให้สรุปวิเคราะห์เป็นภาพรวมตามหมวดหมู่สินทรัพย์ เว้นแต่ผู้ใช้จะถามเจาะจง
3. ข้อมูลล่าสุดเท่านั้น ใช้วันที่ปัจจุบันข้างต้น ข้อมูลตลาด ราคา และข่าวต้องค้นออนไลน์ทุกครั้ง ห้ามใช้ความจำสำหรับการฝึกโมเดล ทุกข้อมูลต้องระบุวันที่กำกับ
4. ตัวเลขในพอร์ตให้ใช้ค่าที่คำนวณมาให้ด้านล่างนี้เท่านั้น ห้ามคำนวณใหม่เอง
5. ใช้เฉพาะแหล่งข้อมูลที่น่าเชื่อถือ (เช่น SET, กลต., ธปท., Reuters, Bloomberg)
6. ขนาดตัวหนังสือ: ครอบข้อความหลักทั้งหมดด้วยแท็ก HTML ขนาดใหญ่เพื่อให้ตัวหนังสืออ่านง่ายขึ้น เช่น <span style="font-size: 16px; line-height: 1.6;"> ... </span>
7. ท้ายคำตอบทุกครั้งให้มีบรรทัดสั้นๆ ว่า: "ข้อมูลนี้เพื่อประกอบการตัดสินใจ ไม่ใช่คำแนะนำการลงทุนส่วนบุคคล"

## รูปแบบการตอบ
- ตอบเป็นข้อความธรรมดา ห้ามใช้เครื่องหมาย Markdown เช่น ** ## \` | ตาราง
- ใช้หัวข้อเป็นตัวหนังสือธรรมดาตามด้วยเครื่องหมาย : และเว้นบรรทัดระหว่างหัวข้อ
- ใช้ "-" นำหน้ารายการย่อยได้ ตัวเลขให้มีคอมม่าและหน่วย เช่น 1,250,000 บาท, 12.5%
- ท้ายคำตอบให้มีหัวข้อ "แหล่งข้อมูล:" ระบุชื่อแหล่งและวันที่ของข้อมูล

## ข้อมูลพอร์ตที่คำนวณแล้วของผู้ใช้:
${JSON.stringify(portfolioSummary, null, 2)}
`;
}

// Action Prompts (ปรับปรุงโครงสร้างการวิเคราะห์ตามสัดส่วน 50/30/10/10 และตอบโจทย์ทุกปุ่ม)
function getActionPrompt(action, assetContext, newsTopic, userMessage, fileContent) {
  let baseContent = fileContent ? `\n\nเนื้อหาจากไฟล์ที่ผู้ใช้แนบมา:\n${fileContent}` : '';

  switch (action) {
    case 'greeting':
      return `ทักทายสั้นๆ 1 ประโยค และสรุปสุขภาพพอร์ตภาพรวมแบบกระชับ (มูลค่ารวม กำไร/ขาดทุน และเงินสด) ไม่เยิ่นเย้อ`;

    case 'deep_analysis':
      return `วิเคราะห์พอร์ตการลงทุนเชิงลึก โดยอิงตามสัดส่วนเป้าหมายที่ผู้ใช้จัดไว้ (หุ้นไทย 50%, หุ้นต่างประเทศ 30%, ทองคำ 10%, คริปโต 10%) ตอบตามโครงสร้างนี้เท่านั้น:
1. สัดส่วนสินทรัพย์ปัจจุบัน: เปรียบเทียบภาพรวมแต่ละกลุ่มกับเป้าหมาย (หุ้นไทย หุ้นนอก ทองคำ คริปโต)
2. การกระจุกตัวและความเสี่ยง: ประเมินความเสี่ยงค่าเงิน (USD Exposure) และความเสี่ยงตลาด
3. ข้อพิจารณาปรับพอร์ต: แนะนำว่าสินทรัพย์กลุ่มไหนมีสัดส่วนมากหรือน้อยเกินไป ควรเพิ่มหรือลดกลุ่มไหน พร้อมเหตุผลกระชับ`;

    case 'portfolio_summary':
      return `สรุปภาพรวมผลตอบแทนประจำเดือนนี้: อัตรากำไร/ขาดทุนรวมจากเงินต้น, การเติบโตเทียบกับเดือนก่อนหน้า และสรุปภาพรวมการซื้อขายแบบกระชับ ตรงประเด็น`;

    case 'asset_analysis':
      const targetName = assetContext?.name || 'สินทรัพย์';
      const targetTicker = assetContext?.ticker || '';
      const targetType = assetContext?.type || '';

      if (targetType === 'gold') {
        return `วิเคราะห์ทิศทางราคาทองคำ ค้นข้อมูลล่าสุดแล้วตอบ:
1. ราคาปัจจุบัน: ทองคำโลก (USD/ออนซ์) และทองคำแท่งในประเทศ (บาท) ระบุวันเวลา
2. ปัจจัยขับเคลื่อนล่าสุดและแนวโน้มราคา แนวรับ แนวต้าน
3. ข้อพิจารณาสำหรับพอร์ต`;
      }

      if (targetType === 'crypto') {
        return `วิเคราะห์คริปโต: ${targetName} (${targetTicker}) ค้นข้อมูลล่าสุดแล้วตอบ:
1. ราคาปัจจุบัน (USD และบาท) การเปลี่ยนแปลงล่าสุด ระบุเวลา
2. ปัจจัยขับเคลื่อน ทิศทาง แนวรับ แนวต้าน
3. ข้อพิจารณาสำหรับพอร์ต`;
      }

      return `วิเคราะห์สินทรัพย์: ${targetName} (${targetTicker}) ประเภท ${targetType} ค้นข้อมูลล่าสุดแล้วตอบ:
1. ภาพรวมธุรกิจ ผลประกอบการล่าสุด และข่าวสำคัญใน 30 วัน ระบุวันที่
2. แนวโน้มราคา แนวรับ แนวต้าน
3. ข้อพิจารณาสำหรับพอร์ตของผู้ใช้`;

    case 'news_analysis':
      if (newsTopic === 'geopolitics') {
        return `วิเคราะห์สถานการณ์ภูมิรัฐศาสตร์ล่าสุดที่กระทบพอร์ต ค้นข่าวใน 7-14 วันล่าสุด ระบุวันที่ทุกข่าว:
1. ภาพรวมสถานการณ์โลกและภูมิภาคสำคัญ
2. ผลกระทบต่อพอร์ตของผู้ใช้ พร้อมระดับผลกระทบ
3. วิธีป้องกันความเสี่ยง`;
      }
      return `วิเคราะห์เศรษฐกิจมหภาค (สหรัฐฯ จีน เวียดนาม ไทย) ล่าสุดที่กระทบพอร์ต ค้นข้อมูลจากหน่วยงานทางการ ระบุวันที่และงวดข้อมูล พร้อมสรุปผลกระทบต่อพอร์ต`;

    case 'chat':
    default:
      return `ผู้ใช้สอบถามว่า: "${userMessage}"${baseContent}\nตอบคำถามให้ตรงประเด็นโดยใช้ข้อมูลพอร์ตและค้นหาข้อมูลออนไลน์ประกอบถ้าจำเป็น`;
  }
}
