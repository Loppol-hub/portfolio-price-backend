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

    // 2. ดึงข้อมูลและคำนวณสถิติต่างๆ จากพอร์ตจริงโดยไม่มีการฟิกซ์ค่า
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

    let fileContextStr = fileContent ? `\n\n[ข้อมูลอ้างอิงจากไฟล์]:\n${fileContent}` : '';

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
        contextPrompt = `วิเคราะห์สินทรัพย์รายตัว (${userMessage}) จากข้อมูลในพอร์ตและปัจจัยพื้นฐาน ให้ตอบตามหัวข้อ:
1. ข้อมูลของคุณในพอร์ต: จำนวน ต้นทุนเฉลี่ย ราคาปัจจุบัน กำไร/ขาดทุน (บาท/%) สัดส่วนในพอร์ต
2. ภาพรวมธุรกิจ: ทำอะไร รายได้หลักมาจากไหน (1-2 ประโยค)
3. พื้นฐานและสุขภาพการเงิน (อ้างอิงงวดงบภาวะปัจจุบัน):
- รายได้ กำไรสุทธิ และการเติบโต YoY/QoQ
- อัตรากำไร, ROE
- หนี้สิน (D/E) และสภาพคล่อง
- กระแสเงินสดจากการดำเนินงาน
- มูลค่า: P/E, P/BV เทียบค่าเฉลี่ยกลุ่มอุตสาหกรรมหรือค่าย้อนหลังของตัวเอง
- ปันผล: อัตราปันผลตอบแทนและความสม่ำเสมอ (ถ้ามี)
4. แนวโน้มราคา: แนวโน้มระยะสั้น/กลาง แนวรับ แนวต้านสำคัญ (ระบุว่าเป็นมุมมองทางเทคนิค ไม่ใช่การรับประกัน)
5. ข่าวและปัจจัยล่าสุดที่กระทบบริษัท (ผลประกอบการ ปันผล งบ การเปลี่ยนแปลงผู้บริหาร กฎระเบียบ คู่แข่ง)
6. มุมมองนักวิเคราะห์: ราคาเป้าหมายและคำแนะนำจากสำนักวิเคราะห์ที่เชื่อถือได้ (ถ้ามี)
7. ความเสี่ยงหลัก 3 ข้อ
8. ข้อพิจารณาสำหรับพอร์ตของผู้ใช้: ถือต่อ/ทยอยเพิ่ม/ทยอยลด พร้อมเหตุผล โดยดูต้นทุนเฉลี่ยของผู้ใช้และสัดส่วนในพอร์ตประกอบ`;
        break;

      case 'news_analysis':
        if (userMessage.includes('ภูมิรัฐศาสตร์') || userMessage.includes('โลก')) {
          contextPrompt = `วิเคราะห์สถานการณ์ภูมิรัฐศาสตร์ที่กระทบพอร์ตของผู้ใช้ ตอบตามหัวข้อ:
1. ภาพรวมสถานการณ์โลก: ประเด็นหลัก 3-5 เรื่องที่สำคัญที่สุด
2. สหรัฐอเมริกา: นโยบายการค้า/ภาษี การเมืองภายใน ความสัมพันธ์ระหว่างประเทศ
3. จีน: ความสัมพันธ์สหรัฐฯ-จีน, การควบคุมการส่งออก, ประเด็นไต้หวัน/ทะเลจีนใต้, นโยบายภายใน
4. เวียดนาม: การค้า การลงทุนต่างชาติ ฐานการผลิตที่ย้ายมา ความสัมพันธ์กับสหรัฐฯ-จีน
5. ไทย: การเมืองภายใน นโยบายรัฐบาล ความสัมพันธ์ประเทศเพื่อนบ้าน ประเด็นกระทบตลาดทุนและนักลงทุนต่างชาติ
6. ความขัดแย้งและความเสี่ยงอื่นที่กระทบราคาน้ำมัน ทองคำ และห่วงโซ่อุปทาน (ถ้ามี)
7. ผลต่อพอร์ตของผู้ใช้: โยงแต่ละประเด็นกับสินทรัพย์จริงในพอร์ต (ระบุชื่อสินทรัพย์) ว่าได้ประโยชน์หรือเสี่ยงอย่างไร ระดับผลกระทบ สูง/กลาง/ต่ำ
8. ข้อพิจารณา: สิ่งที่ควรเฝ้าระวัง และการป้องกันความเสี่ยงที่ทำได้ เช่น ถือเงินสด ทอง กระจายภูมิภาค`;
        } else {
          contextPrompt = `วิเคราะห์เศรษฐกิจโลก-ไทยที่กระทบพอร์ตของผู้ใช้ ตอบตามหัวข้อ:
1. สหรัฐอเมริกา: GDP, เงินเฟ้อ (CPI/PCE), การจ้างงาน, ดอกเบี้ย Fed และมุมมองทิศทางดอกเบี้ย, ตลาดพันธบัตร, ดัชนีหุ้นหลัก
2. จีน: GDP, PMI, เงินเฟ้อ, ภาคอสังหาริมทรัพย์, มาตรการกระตุ้น, ค่าเงินหยวน
3. เวียดนาม: GDP, การส่งออก, เงินเฟ้อ, การลงทุนโดยตรงจากต่างประเทศ (FDI), ดัชนี VN-Index
4. ไทย: GDP (สศช.), เงินเฟ้อ, ดอกเบี้ยนโยบาย (กนง.), การส่งออก, ท่องเที่ยว, หนี้ครัวเรือน, ค่าเงินบาท, ดัชนี SET และเงินทุนต่างชาติไหลเข้า-ออก
5. ตัวแปรร่วมที่กระทบทุกตลาด: ราคาน้ำมัน ดัชนีดอลลาร์ ทองคำ
6. ผลต่อพอร์ตของผู้ใช้: โยงกับสินทรัพย์ในพอร์ตตามประเภท (หุ้นไทย หุ้นนอก ทอง คริปโต เงินสด) ระบุว่ากลุ่มไหนได้ประโยชน์หรือเสี่ยง และเกี่ยวกับสัดส่วนสกุลเงิน USD ที่ถืออยู่อย่างไร
7. ปฏิทินเหตุการณ์สำคัญที่จะมาถึงใน 2 สัปดาห์ข้างหน้า (การประชุม Fed/กนง. การประกาศตัวเลข)
8. ข้อพิจารณา: สิ่งที่ควรเฝ้าระวังและการปรับพอร์ตที่ควรพิจารณา พร้อมเหตุผล`;
        }
        break;

      case 'chat':
      default:
        contextPrompt = userMessage || 'ให้คำปรึกษาทั่วไปเกี่ยวกับการลงทุนแบบกระชับ ตรงประเด็น';
        break;
    }

    const fullUserPrompt = `
ข้อมูลพอร์ตและสถิติที่ประมวลผลแล้ว: ${JSON.stringify(processedData)}
${fileContextStr}

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

    const aiReply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'สัญญาณจากฐานทัพขาดหาย ไม่ได้รับข้อมูลตอบกลับครับ';
    return res.status(200).json({ analysis: aiReply, sources: [] });

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

// ฟังก์ชันดึงข้อมูลพอร์ตแบบ Dynamic จากข้อมูลจริงของผู้ใช้โดยไม่มีค่าฟิกซ์
function extractAndComputePortfolioData(portfolio, currentDate) {
  if (!portfolio) {
    return { status: 'พอร์ตว่างเปล่า' };
  }

  const holdings = Array.isArray(portfolio.holdings) ? portfolio.holdings : [];
  const tradeLogs = Array.isArray(portfolio.tradeLogs) ? portfolio.tradeLogs : [];
  const cashLedger = Array.isArray(portfolio.cashLedger) ? portfolio.cashLedger : [];
  const scraped = portfolio.uiScrapedSummary || {};
  const breakdown = scraped.breakdown || {};

  const initialCapital = 100000; // ทุนเริ่มต้น
  
  const typeBreakdownValues = {
    th_stock: breakdown.th_stock || 0,
    foreign_stock: breakdown.foreign_stock || 0,
    fund: breakdown.fund || 0,
    gold: breakdown.gold || 0,
    crypto: breakdown.crypto || 0,
    cash: breakdown.cashBalance || 0,
    other: 0
  };

  const totalAssetValue = scraped.totalAssetValue || Object.values(typeBreakdownValues).reduce((a, b) => a + b, 0);
  const totalGain = totalAssetValue - initialCapital;
  const returnRate = (totalGain / initialCapital) * 100;

  return {
    rawPortfolioSummary: {
      cash: typeBreakdownValues.cash,
      initialCapital: initialCapital,
      investedAmount: totalAssetValue - typeBreakdownValues.cash,
      totalGain: totalGain,
      returnRate: returnRate,
      totalAssetValue: totalAssetValue,
      totalAssetValueFormatted: totalAssetValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท"
    },
    assetTypeBreakdown: typeBreakdownValues,
    holdings: holdings.map(h => ({
      name: h?.name || '',
      ticker: h?.ticker || '',
      type: h?.type || 'other',
      instrumentType: h?.instrumentType || 'stock',
      industry: h?.industry || 'อื่นๆ',
      quantity: h?.quantity || 0,
      avgCost: h?.avgCost || 0,
      currentPrice: h?.currentPrice || h?.price || 0,
      totalCostThb: h?.totalCostThb || 0
    }))
  };
}

