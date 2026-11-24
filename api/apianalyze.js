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

    // 1. ดึงวันที่และเวลาปัจจุบัน เขตเวลา Asia/Bangkok (ใช้ปี ค.ศ. ตามแอพหลัก)
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

## กฎเหล็กข้อบังคับ:
1. ตัวเลขทุกตัวในคำตอบต้องคัดลอกจากข้อมูล JSON (Pre-calculated Summary และ Snapshot) ที่ให้มาเท่านั้น! ห้ามคำนวณใหม่ ห้ามปัดเศษเอง ห้ามยกตัวอย่างตัวเลขเด็ดขาด
2. รูปแบบตัวเลขต้องใช้ตามที่กำหนด เช่น X,XXX.XX บาท หรือ XX.XX% เท่านั้น
3. ถ้าไม่มีข้อมูลในฟิลด์นั้น ให้เขียนว่า 'ไม่มีข้อมูล' ห้ามแต่งข้อมูลขึ้นมาเอง
4. ห้ามกล่าวถึงสินทรัพย์หรืออุตสาหกรรมที่ไม่อยู่ในรายการ holdings ของพอร์ต
5. ห้ามใช้ Markdown ทุกชนิด เช่น ** ## \` | --- และห้ามทำตาราง
6. ห้ามเขียนเป็นย่อหน้ายาวติดกัน ให้แบ่งเป็นหัวข้อสั้นๆ เสมอ
7. หัวข้อพิมพ์เลขลำดับ จุด ตามด้วยชื่อหัวข้อ แล้วขึ้นบรรทัดใหม่
8. ใต้หัวข้อ ให้แต่ละประเด็นขึ้นบรรทัดใหม่ และขึ้นต้นด้วย "- " ทุกบรรทัด หนึ่งบรรทัดต่อหนึ่งประเด็น
9. เริ่มคำตอบด้วยบรรทัด "สรุปสั้นๆ:" ตามด้วย 1-2 ประโยคที่เป็นข้อสรุปสำคัญที่สุด
10. ท้ายคำตอบเรียงตามนี้โดยเว้นบรรทัด:
   แหล่งข้อมูล: พอร์ตของผู้ใช้ ณ ${snapshotDateStr}
   ข้อมูลที่ยังไม่ครบ: ไม่มี
   ข้อมูลนี้เพื่อประกอบการตัดสินใจ ไม่ใช่คำแนะนำการลงทุนส่วนบุคคล
    `.trim();

    if (customPrompt) {
      systemInstruction += `\n\nกติกาเพิ่มเติมจากผู้ใช้:\n${customPrompt}`;
    }

    let fileContextStr = fileContent ? `\n\n[ข้อมูลอ้างอิงจากไฟล์]:\n${fileContent}` : '';

    // 4. ปรับแต่งโครงสร้างคำสั่งของแต่ละปุ่ม
    let contextPrompt = '';
    
    switch (action) {
      case 'greeting':
        contextPrompt = `สรุปสถานะพอร์ตวันนี้ไม่เกิน 4 บรรทัด: มูลค่ารวม (${preCalculatedSummary.totalAssetValueText}), กำไร/ขาดทุน (${preCalculatedSummary.unrealizedGainText}), สัดส่วนเงินสด (${preCalculatedSummary.cashRatioText})`;
        break;

      case 'deep_analysis':
        contextPrompt = `วิเคราะห์พอร์ตการลงทุนเชิงลึกตามข้อมูล Pre-calculated และ Snapshot ที่ให้มา:
1. ภาพรวมพอร์ต: มูลค่ารวม ${preCalculatedSummary.totalAssetValueText}, ต้นทุน ${snapshot.totalInvestedCost?.toLocaleString('en-US', {minimumFractionDigits:2})} บาท, กำไร ${preCalculatedSummary.unrealizedGainText} (${preCalculatedSummary.unrealizedGainPctText})
2. สัดส่วนสินทรัพย์: แจกแจงมูลค่าและเปอร์เซ็นต์ของแต่ละประเภทจาก byType ให้ครบถ้วน
3. ความกระจุกตัว: 
- เทียบเป้าหมาย: หุ้นไทย ${targetComparisons[0].actual.toFixed(2)}% (${targetComparisons[0].status}), หุ้นนอก ${targetComparisons[1].actual.toFixed(2)}% (${targetComparisons[1].status}), ทองคำ ${targetComparisons[2].actual.toFixed(2)}% (${targetComparisons[2].status}), คริปโต ${targetComparisons[3].actual.toFixed(2)}% (${targetComparisons[3].status})
- สินทรัพย์รายตัวที่เกิน 20%: ${preCalculatedSummary.over20Names.length > 0 ? preCalculatedSummary.over20Names.join(', ') : 'ไม่มี'}
- 3 อันดับแรก (${preCalculatedSummary.top3Assets.join(', ')} รวมกัน ${preCalculatedSummary.top3PctSumText})
4. ความเสี่ยงหลัก: สรุปความเสี่ยงจากสัดส่วนและสินทรัพย์ในพอร์ตจริง
5. ข้อพิจารณาปรับพอร์ต: แนะนำแนวทางปรับพอร์ตสั้นๆ ตามข้อมูลจริง`;
        break;

      case 'portfolio_summary':
        contextPrompt = `สรุปผลตอบแทนประจำเดือนนี้จากข้อมูล Pre-calculated:
1. ช่วงเวลา: เดือนปัจจุบัน
2. การซื้อขาย: ซื้อ ${preCalculatedSummary.currentMonthTradeSummary.buyCount} รายการ (${preCalculatedSummary.currentMonthTradeSummary.totalBuyValText}), ขาย ${preCalculatedSummary.currentMonthTradeSummary.sellCount} รายการ (${preCalculatedSummary.currentMonthTradeSummary.totalSellValText}), ค่าธรรมเนียมรวม ${preCalculatedSummary.currentMonthTradeSummary.totalFeeThbText}
3. กำไร/ขาดทุนเดือนนี้: ${preCalculatedSummary.currentMonthTradeSummary.totalPnlThbText}`;
        break;

      case 'asset_analysis':
        const targetAsset = assetContext ? holdings.find(h => h.name.toLowerCase().includes((assetContext.name || '').toLowerCase())) : null;
        contextPrompt = `วิเคราะห์สินทรัพย์ ${userMessage} จากพอร์ตจริง:
1. ข้อมูลในพอร์ต: ${targetAsset ? `จำนวน ${targetAsset.qty}, ต้นทุนเฉลี่ย ${targetAsset.avg}, ราคาปัจจุบัน ${targetAsset.price}, มูลค่า ${targetAsset.marketValue} บาท (${targetAsset.pctOfTotal?.toFixed(2)}% ของพอร์ต)` : 'ไม่มีข้อมูลรายตัวในพอร์ต'}
2. มุมมองและข้อพิจารณา: วิเคราะห์แนวโน้มและคำแนะนำตามสัดส่วนที่มีอยู่จริง`;
        break;

      case 'news_analysis':
        contextPrompt = `วิเคราะห์ผลกระทบของข่าว (${userMessage}) ต่อสินทรัพย์จริงในพอร์ต (${holdings.map(h => h.name).join(', ')}) และสัดส่วนเงินสด (${preCalculatedSummary.cashRatioText})`;
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
