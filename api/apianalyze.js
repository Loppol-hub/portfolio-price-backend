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

    // 2. คำนวณล่วงหน้าใน Backend (Pre-calculation ห้ามให้โมเดลคำนวณเอง)
    const holdings = Array.isArray(snapshot.holdings) ? snapshot.holdings : [];
    
    // สัดส่วนเป้าหมายเทียบจริง
    const actualMap = {};
    byTypeArr.forEach(t => { actualMap[t.key] = t.pctOfTotal || 0; });
    
    const foreignActual = (actualMap['foreign_stock'] || 0);
    const targetComparisons = [
      { cat: 'หุ้นไทย', target: 50, actual: actualMap['th_stock'] || 0 },
      { cat: 'หุ้นนอกรวม DR', target: 30, actual: foreignActual },
      { cat: 'ทองคำ', target: 10, actual: actualMap['gold'] || 0 },
      { cat: 'คริปโต', target: 10, actual: actualMap['crypto'] || 0 }
    ].map(item => {
      const dev = item.actual - item.target;
      let status = 'ใกล้เคียง (±2%)';
      if (dev > 2) status = 'เกิน';
      else if (dev < -2) status = 'ต่ำกว่า';
      return { ...item, deviation: dev, status };
    });

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
      targetComparisons,
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
   แหล่งข้อมูล: พอร์ตของผู้ใช้ ณ ${snapshotDateStr}
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

    // 4. ปรับแต่งโครงสร้างคำสั่งของแต่ละปุ่ม (คืนค่า Prompt เต็มครบถ้วน)
    let contextPrompt = '';
    
    switch (action) {
      case 'greeting':
        contextPrompt = `สรุปสถานะพอร์ตวันนี้ไม่เกิน 4 บรรทัด: มูลค่ารวม (${preCalculatedSummary.totalAssetValueText}), กำไร/ขาดทุน (${preCalculatedSummary.unrealizedGainText}), สัดส่วนเงินสด (${preCalculatedSummary.cashRatioText})`;
        break;

      case 'deep_analysis':
        contextPrompt = `วิเคราะห์พอร์ตการลงทุนเชิงลึก ให้ตอบตามหัวข้อด้วยข้อความธรรมดาและขึ้นบรรทัดใหม่ทุกรายการย่อย:
1. ภาพรวมพอร์ต: มูลค่ารวม ${preCalculatedSummary.totalAssetValueText}, ต้นทุน ${snapshot.totalInvestedCost?.toLocaleString('en-US', {minimumFractionDigits:2})} บาท, กำไร ${preCalculatedSummary.unrealizedGainText} (${preCalculatedSummary.unrealizedGainPctText})
2. สัดส่วนสินทรัพย์: แจกแจงมูลค่าและเปอร์เซ็นต์ของแต่ละประเภทจาก byType ให้ครบถ้วน พร้อมระบุประเภทที่มากที่สุด
3. ความกระจุกตัว: 
- สัดส่วนเป้าหมายที่ตั้งไว้ (หุ้นไทย 50%, หุ้นนอกรวม DR 30%, ทองคำ 10%, คริปโต 10%) หากกลุ่มไหนเกินหรือต่ำกว่าให้แจ้งเตือน (หุ้นไทย: ${targetComparisons[0].actual.toFixed(2)}% [${targetComparisons[0].status}], หุ้นนอก: ${targetComparisons[1].actual.toFixed(2)}% [${targetComparisons[1].status}], ทองคำ: ${targetComparisons[2].actual.toFixed(2)}% [${targetComparisons[2].status}], คริปโต: ${targetComparisons[3].actual.toFixed(2)}% [${targetComparisons[3].status}])
- สินทรัพย์รายตัวที่มีสัดส่วนเกิน 20% ของพอร์ต: ${preCalculatedSummary.over20Names.length > 0 ? preCalculatedSummary.over20Names.join(', ') : 'ไม่มี'}
- 3 อันดับแรก (${preCalculatedSummary.top3Assets.join(', ')}) รวมกัน ${preCalculatedSummary.top3PctSumText}
4. ความเสี่ยงหลัก: จัดลำดับ 3 ข้อ แต่ละข้อมีเหตุผลสั้นๆ (ความเสี่ยงตลาด, สภาพคล่อง, ความผันผวน, ค่าเงิน, ค่าธรรมเนียม)
5. จุดแข็งของพอร์ต: 1-2 ข้อ
6. ข้อพิจารณาปรับพอร์ต: 1-3 ข้อ เรียงตามความสำคัญ แต่ละข้อบอกเหตุผลและสิ่งที่ควรระวัง`;
        break;

      case 'portfolio_summary':
        contextPrompt = `สรุปผลตอบแทนประจำเดือนนี้ โดยอิงจากข้อมูลที่คำนวณมาให้:
1. ช่วงเวลา: เดือนและปีปัจจุบัน
2. การซื้อขายในเดือนนี้:
- จำนวนรายการซื้อ (${preCalculatedSummary.currentMonthTradeSummary.buyCount} รายการ, มูลค่ารวม ${preCalculatedSummary.currentMonthTradeSummary.totalBuyValText}) / จำนวนรายการขาย (${preCalculatedSummary.currentMonthTradeSummary.sellCount} รายการ, มูลค่ารวม ${preCalculatedSummary.currentMonthTradeSummary.totalSellValText})
- ค่าธรรมเนียมรวม ${preCalculatedSummary.currentMonthTradeSummary.totalFeeThbText}
3. กำไร/ขาดทุนเดือนนี้: ${preCalculatedSummary.currentMonthTradeSummary.totalPnlThbText}
4. ข้อสังเกตสั้นๆ 2-3 ข้อ`;
        break;

      case 'asset_analysis':
        const targetAsset = assetContext ? holdings.find(h => h.name.toLowerCase().includes((assetContext.name || '').toLowerCase()) || (h.ticker && h.ticker.toLowerCase().includes((assetContext.ticker || '').toLowerCase()))) : null;
        contextPrompt = `วิเคราะห์สินทรัพย์ ${userMessage} (เป้าหมาย: ${assetContext?.name || userMessage}) จากข้อมูลในพอร์ตและปัจจัยพื้นฐาน ให้ตอบตามหัวข้อ:
1. ข้อมูลของคุณในพอร์ต: ${targetAsset ? `จำนวน ${targetAsset.qty}, ต้นทุนเฉลี่ย ${targetAsset.avg}, ราคาปัจจุบัน ${targetAsset.price}, มูลค่า ${targetAsset.marketValue.toLocaleString('en-US', {minimumFractionDigits:2})} บาท (${targetAsset.pctOfTotal?.toFixed(2)}% ของพอร์ต), กำไร/ขาดทุน ${targetAsset.gain >= 0 ? '+' : ''}${targetAsset.gain.toLocaleString('en-US', {minimumFractionDigits:2})} บาท (${targetAsset.gainPct?.toFixed(2)}%)` : 'ไม่มีข้อมูลรายตัวนี้ในพอร์ต'}
2. ภาพรวมธุรกิจหรือลักษณะสินทรัพย์: ทำอะไร หรือมีลักษณะสำคัญอย่างไร (1-2 ประโยค)
3. ปัจจัยพื้นฐานและแนวโน้มราคา: แนวโน้มระยะสั้น/กลาง แนวรับ แนวต้านสำคัญ หรือปัจจัยขับเคลื่อนราคา
4. ข่าวและปัจจัยล่าสุดที่กระทบ (ผลประกอบการ ผลลัพธ์ทางเศรษฐกิจ หรือข่าวสารตลาด)
5. ความเสี่ยงหลัก 3 ข้อ
6. ข้อพิจารณาสำหรับพอร์ตของผู้ใช้: ถือต่อ/ทยอยเพิ่ม/ทยอยลด พร้อมเหตุผล โดยดูต้นทุนเฉลี่ยของผู้ใช้และสัดส่วนในพอร์ตประกอบ`;
        break;

      case 'news_analysis':
        if (newsTopic === 'geopolitics' || (userMessage && (userMessage.includes('ภูมิรัฐศาสตร์') || userMessage.includes('โลก')))) {
          contextPrompt = `วิเคราะห์สถานการณ์ภูมิรัฐศาสตร์ที่กระทบพอร์ตของผู้ใช้ ตอบตามหัวข้อ:
1. ภาพรวมสถานการณ์โลก: ประเด็นหลัก 3-5 เรื่องที่สำคัญที่สุดในปัจจุบัน
2. ผลต่อพอร์ตของผู้ใช้: โยงแต่ละประเด็นกับสินทรัพย์จริงในพอร์ต (${holdings.map(h => h.name).join(', ')}) ว่าได้ประโยชน์หรือเสี่ยงอย่างไร ระดับผลกระทบ สูง/กลาง/ต่ำ
3. ข้อพิจารณา: สิ่งที่ควรเฝ้าระวัง และการป้องกันความเสี่ยงที่ทำได้ เช่น ถือเงินสด ทอง กระจายภูมิภาค`;
        } else {
          contextPrompt = `วิเคราะห์เศรษฐกิจโลก-ไทยที่กระทบพอร์ตของผู้ใช้ ตอบตามหัวข้อ:
1. ภาพรวมเศรษฐกิจหลัก (สหรัฐฯ, จีน, ไทย) และทิศทางดอกเบี้ย/เงินเฟ้อ
2. ผลต่อพอร์ตของผู้ใช้: โยงกับสินทรัพย์ในพอร์ตตามประเภท (หุ้นไทย หุ้นนอก ทอง คริปโต เงินสด) ระบุว่ากลุ่มไหนได้ประโยชน์หรือเสี่ยง และเกี่ยวกับสัดส่วนสกุลเงิน USD ที่ถืออยู่อย่างไร
3. ข้อพิจารณา: สิ่งที่ควรเฝ้าระวังและการปรับพอร์ตที่ควรพิจารณา พร้อมเหตุผล`;
        }
        break;

      case 'chat':
      default:
        contextPrompt = userMessage || 'ให้คำปรึกษาทั่วไปเกี่ยวกับการลงทุนแบบกระชับ ตรงประเด็น';
        break;
    }

    const fullUserPrompt = `
ข้อมูล Pre-calculated Summary ของพอร์ต: ${JSON.stringify(preCalculatedSummary)}
ข้อมูล Snapshot ดิบ: ${JSON.stringify(snapshot)}
${fileContextStr}

คำสั่ง: ${contextPrompt}
    `.trim();

    // 5. เรียกใช้งาน Gemini API (ใช้ gemini-3.5-flash-lite)
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
