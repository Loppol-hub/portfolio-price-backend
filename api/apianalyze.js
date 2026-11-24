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
    const { action, portfolio, userMessage, customPrompt, fileContent, assetContext, newsTopic } = req.body;

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
      return res.status(200).json({ analysis: '⚠️ ระบบหลังบ้านยังไม่ได้ตั้งค่า GEMINI_API_KEY บน Vercel ครับ' });
    }

    const snapshot = portfolio?.snapshot;
    if (!snapshot) {
      return res.status(200).json({ analysis: "ยังไม่ได้รับข้อมูลพอร์ตล่าสุด กรุณาเปิดหน้าพอร์ตรวมแล้วลองใหม่", sources: [] });
    }

    // ตรวจความสอดคล้อง (Consistency Check)
    const totalAssetValue = snapshot.totalAssetValue || 0;
    const byTypeArr = Array.isArray(snapshot.byType) ? snapshot.byType : [];
    const sumByType = byTypeArr.reduce((s, t) => s + (t.value || 0), 0);
    const sumInvPlusCash = (snapshot.totalInvestedValue || 0) + (snapshot.cash || 0);

    if (Math.abs(sumByType - totalAssetValue) > 1 || Math.abs(sumInvPlusCash - totalAssetValue) > 1) {
      return res.status(200).json({
        analysis: `⚠️ ข้อมูลพอร์ตไม่สอดคล้องกัน: มูลค่ารวม (${totalAssetValue.toLocaleString('en-US', {minimumFractionDigits:2})} บาท) ไม่ตรงกับผลรวมประเภท (${sumByType.toLocaleString('en-US', {minimumFractionDigits:2})} บาท) หรือเงินสด+เงินลงทุน (${sumInvPlusCash.toLocaleString('en-US', {minimumFractionDigits:2})} บาท)`,
        sources: []
      });
    }

    // 1. ดึงวันที่และเวลาปัจจุบัน เขตเวลา Asia/Bangkok
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('th-TH-u-ca-gregory', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit'
    });
    const currentTimeStr = formatter.format(now);
    const snapshotDateStr = snapshot.snapshotAt ? formatter.format(new Date(snapshot.snapshotAt)) : currentTimeStr;

    // 2. คำนวณล่วงหน้าใน Backend (Pre-calculation)
    const holdings = Array.isArray(snapshot.holdings) ? snapshot.holdings : [];
    
    const actualMap = {};
    byTypeArr.forEach(t => { actualMap[t.key] = t.pctOfTotal || 0; });
    
    const sortedHoldings = [...holdings].sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));
    const top3 = sortedHoldings.slice(0, 3);
    const top3PctSum = top3.reduce((s, h) => s + (h.pctOfTotal || 0), 0);
    const over20 = holdings.filter(h => (h.pctOfTotal || 0) > 20);

    const currentMonthPrefix = new Date().toISOString().slice(0, 7);
    const tradeLogs = Array.isArray(snapshot.tradeLogs) ? snapshot.tradeLogs : [];
    const currentMonthTrades = tradeLogs.filter(l => l && l.date && l.date.startsWith(currentMonthPrefix));
    const buyTrades = currentMonthTrades.filter(l => l.action === 'buy');
    const sellTrades = currentMonthTrades.filter(l => l.action === 'sell');
    
    let totalBuyVal = 0, totalSellVal = 0, totalFeeThb = 0, totalPnlThb = 0;
    currentMonthTrades.forEach(l => {
      const logFx = (l.currency === 'USD' && l.assetType !== 'th_stock' && l.instrumentType !== 'dr') ? (l.tradeFx || snapshot.fxRate || 36.5) : 1;
      const val = (l.quantity || 0) * (l.price || 0) * logFx;
      if (l.action === 'buy') totalBuyVal += val;
      if (l.action === 'sell') totalSellVal += val;
      totalFeeThb += (l.feeThbRecord || 0);
      if (l.pnlThb !== undefined) totalPnlThb += l.pnlThb;
    });

    const preCalculatedSummary = {
      totalAssetValueText: totalAssetValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท",
      unrealizedGainText: (snapshot.unrealizedGain >= 0 ? "+" : "") + (snapshot.unrealizedGain || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท",
      unrealizedGainPctText: (snapshot.unrealizedGainPct >= 0 ? "+" : "") + (snapshot.unrealizedGainPct || 0).toFixed(2) + "%",
      cashText: (snapshot.cash || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท",
      cashRatioText: (snapshot.cashRatioPct || 0).toFixed(2) + "%",
      top3Assets: top3.map(h => `${h.name} (${(h.pctOfTotal || 0).toFixed(2)}%)`),
      top3PctSumText: top3PctSum.toFixed(2) + "%",
      over20Names: over20.map(h => h.name),
      currentMonthTradeSummary: {
        buyCount: buyTrades.length,
        sellCount: sellTrades.length,
        totalBuyValText: totalBuyVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท",
        totalSellValText: totalSellVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท",
        totalFeeThbText: totalFeeThb.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท",
        totalPnlThbText: (totalPnlThb >= 0 ? "+" : "") + totalPnlThb.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท"
      }
    };

    // 3. กำหนดกฎการตอบตามข้อกำหนดการจัดหน้าบนมือถือ
    let systemInstruction = `
คุณคือผู้ช่วยอัจฉริยะด้านการลงทุน โทนเสียงกระชับ เป็นมืออาชีพ ตรงประเด็น "ขอเนื้อๆ ไม่เอาน้ำ"
วันที่และเวลาปัจจุบัน (Asia/Bangkok): ${currentTimeStr}

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
8. ตัวเลขใส่คอมม่าและหน่วยเสมอ ห้ามปัดเศษเอง คัดลอกตามข้อมูลที่ให้มา
9. ท้ายคำตอบเรียงตามนี้ โดยเว้นบรรทัดก่อนแต่ละส่วน:
   แหล่งข้อมูล: พอร์ตของผู้ใช้ ณ ${snapshotDateStr} และข้อมูลตลาดล่าสุด
   ข้อมูลที่ยังไม่ครบ: ไม่มี
   ข้อมูลนี้เพื่อประกอบการตัดสินใจ ไม่ใช่คำแนะนำการลงทุนส่วนบุคคล

กฎเพิ่มเติม:
- ห้ามใส่คำทักทายซ้ำซาก หรือเล่นบทบาทสมมติซ้ำซ้อนในทุกครั้งที่กดปุ่ม
- ห้ามแต่งข้อมูล ตัวเลข หรือสร้างข่าวเท็จขึ้นมาเองเด็ดขาด (No Hallucination)
    `.trim();

    if (customPrompt) {
      systemInstruction += `\n\nกติกาเพิ่มเติมจากผู้ใช้:\n${customPrompt}`;
    }

    let fileContextStr = fileContent ? `\n\n[ข้อมูลอ้างอิงจากไฟล์]:\n${fileContent}` : '';

    // 4. Prompt ใหม่ล่าสุดตามที่ผู้ใช้กำหนดสำหรับแต่ละปุ่ม
    let contextPrompt = '';
    
    switch (action) {
      case 'greeting':
        contextPrompt = `สรุปสถานะพอร์ตวันนี้ไม่เกิน 4 บรรทัด: มูลค่ารวม (${preCalculatedSummary.totalAssetValueText}), กำไร/ขาดทุน (${preCalculatedSummary.unrealizedGainText}), สัดส่วนเงินสด (${preCalculatedSummary.cashRatioText})`;
        break;

      case 'deep_analysis':
        contextPrompt = `วิเคราะห์พอร์ตเชิงลึกจาก "ข้อมูลพอร์ตที่คำนวณแล้ว" และค้นข้อมูลปัจจุบันที่เกี่ยวข้อง
ตอบตามหัวข้อนี้ตามลำดับ:
1. ภาพรวมพอร์ต: มูลค่ารวม ${preCalculatedSummary.totalAssetValueText}, ต้นทุน ${snapshot.totalInvestedCost?.toLocaleString('en-US', {minimumFractionDigits:2})} บาท, กำไร/ขาดทุน ${preCalculatedSummary.unrealizedGainText} (${preCalculatedSummary.unrealizedGainPctText}) ณ วันที่ปัจจุบัน
2. สัดส่วนสินทรัพย์: แยกตามประเภท (หุ้นไทย/หุ้นนอก/กองทุน/ทอง/คริปโต/เงินสด) พร้อมบอกว่าประเภทไหนมากสุด
3. ความกระจุกตัว:
   - สินทรัพย์รายตัวที่มีสัดส่วนเกิน 20% ของพอร์ต (ถ้ามี) ระบุชื่อและ % (${preCalculatedSummary.over20Names.length > 0 ? preCalculatedSummary.over20Names.join(', ') : 'ไม่มี'})
   - กลุ่มอุตสาหกรรมที่กระจุกตัว (จากฟิลด์ industry)
   - ถ้ามีหุ้นต่างประเทศหรือ DR หลายตัวในธีมเดียวกัน (เช่น เทคโนโลยีสหรัฐฯ) ให้ชี้ว่าซ้อนทับกัน
4. ความเสี่ยงหลัก: จัดลำดับ 3 ข้อ แต่ละข้อมีเหตุผลสั้นๆ (ความเสี่ยงตลาด, สภาพคล่อง/เงินสดต่ำหรือสูงเกินไป, ความผันผวนของคริปโต/ทอง, ค่าเงิน, ค่าธรรมเนียม)
5. จุดแข็งของพอร์ต: 1-2 ข้อ
6. ข้อพิจารณาปรับพอร์ต: 1-3 ข้อ เรียงตามความสำคัญ แต่ละข้อบอกเหตุผลและสิ่งที่ควรระวัง 
7. บริบทตลาดปัจจุบันที่เกี่ยวกับพอร์ตนี้: ค้นข่าวเศรษฐกิจ/ตลาดล่าสุด 1-2 เรื่องที่กระทบสินทรัพย์ในพอร์ตจริง ระบุวันที่
(ห้ามเสนอสินทรัพย์ใหม่เป็นคำสั่งซื้อ เสนอได้เฉพาะ "ประเภท/ธีม" ที่ช่วยกระจายความเสี่ยง)`;
        break;

      case 'portfolio_summary':
        contextPrompt = `สรุปผลงานพอร์ตของเดือนปัจจุบัน ใช้เฉพาะ "ข้อมูลพอร์ตที่คำนวณแล้ว" ไม่ต้องค้นเว็บ
ตอบตามหัวข้อนี้:
1. ช่วงเวลา: ระบุเดือนและปี (${currentMonthPrefix})
2. การซื้อขายในเดือนนี้:
   - จำนวนรายการซื้อ (${preCalculatedSummary.currentMonthTradeSummary.buyCount} รายการ) / จำนวนรายการขาย (${preCalculatedSummary.currentMonthTradeSummary.sellCount} รายการ)
   - รายชื่อสินทรัพย์ที่ซื้อ (ชื่อ จำนวน ราคา วันที่) และที่ขาย
   - มูลค่าเงินซื้อรวม (${preCalculatedSummary.currentMonthTradeSummary.totalBuyValText}) / มูลค่าเงินขายรวม (${preCalculatedSummary.currentMonthTradeSummary.totalSellValText})
   - ค่าธรรมเนียมรวม (${preCalculatedSummary.currentMonthTradeSummary.totalFeeThbText})
3. กำไร/ขาดทุนเดือนนี้:
   - กำไร/ขาดทุนที่รับรู้จากการขาย (บาท) แยกรายตัว
   - ปันผลที่ได้รับ (ถ้ามี)
   - กำไร/ขาดทุนที่ยังไม่รับรู้ของพอร์ต ณ วันนี้ (${preCalculatedSummary.unrealizedGainText} / ${preCalculatedSummary.unrealizedGainPctText})
4. การเติบโตของพอร์ต:
   - เทียบสิ้นเดือนก่อน (ถ้ามีข้อมูลใน history)
   - เทียบช่วงเดียวกันของปีที่แล้ว หรือสิ้นปีที่แล้ว (จาก yearlyHistory) เป็น %
   - ต้องแยกให้ชัดเจนว่าการโตมาจากเงินทุนที่เติมเข้ามา (capital_add) หรือจากผลตอบแทนจริง
5. ถ้าไม่มีข้อมูลเดือนก่อน/ปีก่อน ให้บอกว่า "ยังไม่มีข้อมูลเปรียบเทียบ" ห้ามประมาณเอง
6. ข้อสังเกตสั้นๆ 2-3 ข้อ (เช่น ซื้อบ่อยเกินไปไหม ค่าธรรมเนียมสูงเมื่อเทียบกำไรไหม)`;
        break;

      case 'asset_analysis':
        const assetType = assetContext?.type;
        const assetName = assetContext?.name || userMessage;
        
        if (assetType === 'gold') {
          contextPrompt = `วิเคราะห์ทิศทางราคาทองคำ ค้นข้อมูลล่าสุดแล้วตอบ:
1. ราคาปัจจุบัน: ทองคำโลก (USD/ออนซ์) และทองคำแท่งในประเทศ (บาท/บาททอง ราคารับซื้อ-ขายออก) จากสมาคมค้าทองคำ ระบุวันและเวลาอัปเดต
2. ปัจจัยขับเคลื่อน (อ้างข้อมูลล่าสุด): นโยบายดอกเบี้ย Fed, ดัชนีดอลลาร์ (DXY), เงินเฟ้อ, ความตึงเครียดทางภูมิรัฐศาสตร์, การซื้อทองของธนาคารกลาง, กระแสเงินเข้าออกกองทุนทองคำ, และค่าเงินบาท
3. ทิศทางราคา: แนวโน้มระยะสั้น (1-2 สัปดาห์) และระยะกลาง (1-3 เดือน)
4. แนวรับและแนวต้านสำคัญ (ระบุเป็นตัวเลขทั้งราคาโลกและราคาบาททองโดยประมาณ)
5. สถานะของผู้ใช้ในพอร์ต: จำนวน ต้นทุนเฉลี่ย กำไร/ขาดทุน สัดส่วนทองในพอร์ต
6. ข้อพิจารณา: ควรถือ ทยอยซื้อที่แนวรับ หรือทยอยขายที่แนวต้าน พร้อมความเสี่ยง (เช่น ส่วนต่างราคาซื้อ-ขาย, ผลของค่าเงิน)`;
        } else if (assetType === 'crypto') {
          contextPrompt = `วิเคราะห์คริปโต: ${assetName} (${assetContext?.ticker || ''}) ค้นข้อมูลล่าสุดแล้วตอบ:
1. ราคาปัจจุบัน (USD และบาท) การเปลี่ยนแปลง 24 ชม./7 วัน/30 วัน มูลค่าตลาดและอันดับ ระบุเวลาที่ดึงข้อมูล
2. สถานะของผู้ใช้ในพอร์ต: จำนวน ต้นทุนเฉลี่ย กำไร/ขาดทุน สัดส่วนคริปโตในพอร์ต
3. ปัจจัยขับเคลื่อนล่าสุด: ข่าว กฎระเบียบ (ก.ล.ต. ไทย/สหรัฐฯ) การเงินไหลเข้า-ออก ETF การอัปเกรดเครือข่าย เหตุการณ์ Halving/Unlock, ภาวะตลาดโดยรวม (BTC dominance, Fear & Greed Index)
4. ทิศทางราคา: แนวโน้มระยะสั้นและกลาง
5. แนวรับและแนวต้านสำคัญ (ตัวเลขชัดเจน)
6. ความเสี่ยงเฉพาะ: ความผันผวนสูง ความเสี่ยงของโครงการ ความเสี่ยงด้านกฎหมายและแพลตฟอร์ม
7. ข้อพิจารณา: ควรกำหนดสัดส่วนคริปโตไม่ให้เกินความเสี่ยงที่รับได้ ทยอยซื้อ/ทยอยขาย และเตือนตรงๆ ว่าคริปโตเป็นสินทรัพย์เสี่ยงสูง ห้ามชี้นำให้ใช้เงินกู้หรือเลเวอเรจ`;
        } else {
          // หุ้นไทย, หุ้นนอก, DR
          contextPrompt = `วิเคราะห์สินทรัพย์ ${assetName} ค้นข้อมูลล่าสุดจากแหล่งที่น่าเชื่อถือ แล้วตอบตามหัวข้อ:
1. ข้อมูลของคุณในพอร์ต: จำนวน ต้นทุนเฉลี่ย ราคาปัจจุบัน กำไร/ขาดทุน (บาท/%) สัดส่วนในพอร์ต
2. ภาพรวมธุรกิจ: ทำอะไร รายได้หลักมาจากไหน (1-2 ประโยค)
3. พื้นฐานและสุขภาพการเงิน (ระบุงวดงบที่ใช้ เช่น Q1/2026 หรือ FY2025):
   - รายได้ กำไรสุทธิ และการเติบโต YoY/QoQ
   - อัตรากำไร, ROE
   - หนี้สิน (D/E) และสภาพคล่อง
   - กระแสเงินสดจากการดำเนินงาน
   - มูลค่า: P/E, P/BV เทียบค่าเฉลี่ยกลุ่มอุตสาหกรรมหรือค่าย้อนหลังของตัวเอง
   - ปันผล: อัตราปันผลตอบแทนและความสม่ำเสมอ (ถ้ามี)
4. แนวโน้มราคา: แนวโน้มระยะสั้น/กลาง แนวรับ แนวต้านสำคัญ (อ้างอิงจากข้อมูลราคาและปริมาณซื้อขายล่าสุด ระบุว่าเป็นมุมมองทางเทคนิค ไม่ใช่การรับประกัน)
5. ข่าวและปัจจัยล่าสุดใน 30 วัน ที่กระทบบริษัท พร้อมวันที่ (ผลประกอบการ ปันผล งบ การเปลี่ยนแปลงผู้บริหาร กฎระเบียบ คู่แข่ง)
6. มุมมองนักวิเคราะห์: ราคาเป้าหมายและคำแนะนำจากสำนักวิเคราะห์ที่เชื่อถือได้ (ถ้ามี) ระบุสำนักและวันที่
7. ความเสี่ยงหลัก 3 ข้อ
8. ข้อพิจารณาสำหรับพอร์ตของผู้ใช้: ถือต่อ/ทยอยเพิ่ม/ทยอยลด พร้อมเหตุผล โดยดูต้นทุนเฉลี่ยของผู้ใช้และสัดส่วนในพอร์ตประกอบ
(สำหรับ DR ให้ระบุหุ้นต้นทางด้วย)`;
        }
        break;

      case 'news_analysis':
        if (newsTopic === 'geopolitics' || (userMessage && (userMessage.includes('ภูมิรัฐศาสตร์') || userMessage.includes('โลก')))) {
          contextPrompt = `วิเคราะห์สถานการณ์ภูมิรัฐศาสตร์ล่าสุดที่กระทบพอร์ตของผู้ใช้ ค้นข่าวใน 7-14 วันล่าสุด จากสื่อและหน่วยงานที่เชื่อถือได้ ตอบตามหัวข้อ (ทุกข่าวต้องมีวันที่):
1. ภาพรวมสถานการณ์โลก: ประเด็นหลัก 3-5 เรื่องที่สำคัญที่สุดตอนนี้
2. สหรัฐอเมริกา: นโยบายการค้า/ภาษี การเมืองภายใน ความสัมพันธ์ระหว่างประเทศ
3. จีน: ความสัมพันธ์สหรัฐฯ-จีน, การควบคุมการส่งออก, ประเด็นไต้หวัน/ทะเลจีนใต้, นโยบายภายใน
4. เวียดนาม: การค้า การลงทุนต่างชาติ ฐานการผลิตที่ย้ายมา ความสัมพันธ์กับสหรัฐฯ-จีน
5. ไทย: การเมืองภายใน นโยบายรัฐบาล ความสัมพันธ์ประเทศเพื่อนบ้าน ประเด็นกระทบตลาดทุนและนักลงทุนต่างชาติ
6. ความขัดแย้งและความเสี่ยงอื่นที่กระทบราคาน้ำมัน ทองคำ และห่วงโซ่อุปทาน (ถ้ามี)
7. ผลต่อพอร์ตของผู้ใช้: โยงแต่ละประเด็นกับสินทรัพย์จริงในพอร์ต (${holdings.map(h => h.name).join(', ')}) ว่าได้ประโยชน์หรือเสี่ยงอย่างไร ระดับผลกระทบ สูง/กลาง/ต่ำ
8. ข้อพิจารณา: สิ่งที่ควรเฝ้าระวัง และการป้องกันความเสี่ยงที่ทำได้ เช่น ถือเงินสด ทอง กระจายภูมิภาค
(หลีกเลี่ยงการแสดงความเห็นทางการเมืองส่วนตัว รายงานเฉพาะข้อเท็จจริงและผลต่อการลงทุน)`;
        } else {
          contextPrompt = `วิเคราะห์เศรษฐกิจล่าสุดที่กระทบพอร์ตของผู้ใช้ ค้นข้อมูลล่าสุดจากหน่วยงานทางการและสื่อที่เชื่อถือได้ ระบุเดือน/ไตรมาสของตัวเลขและวันที่ประกาศทุกครั้ง ตอบตามหัวข้อ:
1. สหรัฐอเมริกา: GDP, เงินเฟ้อ (CPI/PCE), การจ้างงาน, ดอกเบี้ย Fed และมุมมองทิศทางดอกเบี้ย (อ้างอิง FedWatch ถ้ามี), ตลาดพันธบัตร, ดัชนีหุ้นหลัก
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
        contextPrompt = userMessage || 'ตอบคำถามของผู้ใช้ให้ตรงประเด็นโดยใช้ข้อมูลพอร์ตที่คำนวณแล้ว ถ้าคำถามเกี่ยวกับราคา ข่าว งบ หรือตลาดปัจจุบัน ให้ค้นข้อมูลล่าสุดก่อนตอบทุกครั้ง ถ้าผู้ใช้แนบไฟล์/รูป ให้อ่านและอ้างอิงเนื้อหานั้น ถ้าคำถามไม่เกี่ยวกับการลงทุนหรือพอร์ต ให้ตอบสั้นๆ และชวนกลับมาที่การดูแลพอร์ต';
        break;
    }

    const fullUserPrompt = `
ข้อมูล Pre-calculated Summary ของพอร์ต: ${JSON.stringify(preCalculatedSummary)}
ข้อมูล Snapshot ดิบ: ${JSON.stringify(snapshot)}
${fileContextStr}

คำสั่ง: ${contextPrompt}
    `.trim();

    // 5. เรียกใช้งาน Gemini API (ใช้ gemini-3.5-flash-lite พร้อมเปิด Google Search Grounding)
    const modelName = 'gemini-3.5-flash-lite';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: `${systemInstruction}\n\n${fullUserPrompt}` }] }
        ],
        tools: [{ googleSearch: {} }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1500,
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
    
    // ดึง Grounding Metadata (แหล่งอ้างอิงเว็บ) ถ้ามี
    let sources = [];
    const groundingChunks = candidate?.groundingMetadata?.groundingChunks;
    if (Array.isArray(groundingChunks)) {
      sources = groundingChunks
        .map(chunk => chunk.web ? { title: chunk.web.title, url: chunk.web.uri } : null)
        .filter(Boolean);
    }

    return res.status(200).json({ analysis: aiReply, sources });

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
