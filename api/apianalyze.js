// apianalyze.js - Backend สำหรับประมวลผล AI ผู้ช่วยนักบินอวกาศ (ดึงข้อมูลพอร์ตตรงๆ ไม่คำนวณซ้ำ)
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

    // 2. ดึงข้อมูลจากพอร์ตตรงๆ (ไม่ผ่านสูตรคำนวณซับซ้อน)
    const directPortfolioData = extractDirectPortfolioData(portfolio);

    // 3. กำหนดกฎการตอบ
    let systemInstruction = `
คุณคือผู้ช่วยอัจฉริยะด้านการลงทุน โทนเสียงกระชับ เป็นมืออาชีพ ตรงประเด็น "ขอเนื้อๆ ไม่เอาน้ำ"
วันที่และเวลาปัจจุบัน (Asia/Bangkok): ${currentTimeStr} (ห้ามเดาวันที่เอง)

กฎเหล็กเคร่งครัด:
1. ห้ามใส่คำทักทายซ้ำซาก (เช่น "สวัสดีครับนักเดินทาง...") หรือเล่นบทบาทสมมติซ้ำซ้อนในทุกครั้งที่กดปุ่ม
2. ห้ามสาธยายรายชื่อหุ้นและจำนวนหุ้นทีละตัวแบบเยิ่นเย้อ ให้สรุปวิเคราะห์เป็นภาพรวมตามหมวดหมู่สินทรัพย์ เว้นแต่ผู้ใช้จะถามเจาะจง
3. ห้ามแต่งข้อมูล ตัวเลข หรือสร้างข่าวเท็จขึ้นมาเองเด็ดขาด (No Hallucination)
4. ตัวเลขสำคัญทั้งหมด (เงินสด, ปันผล, เงินที่นำไปลงทุน, ผลประกอบการรวม, ทุนเริ่มต้นสะสม, รีบาลานซ์) ให้ยึดตามค่าที่ระบุไว้ใน "ข้อมูลพอร์ตจากระบบ" เท่านั้น ห้ามคำนวณหรือเปลี่ยนตัวเลขเองเด็ดขาด
    `.trim();

    if (customPrompt) {
      systemInstruction += `\n\nกติกาเพิ่มเติมจากผู้ใช้:\n${customPrompt}`;
    }

    let fileContext = fileContent ? `\n\n[ข้อมูลอ้างอิงจากไฟล์]:\n${fileContext}` : '';

    // 4. ปรับแต่งโครงสร้างคำสั่งของแต่ละปุ่ม
    let contextPrompt = '';
    
    switch (action) {
      case 'greeting':
        contextPrompt = 'ทักทายต้อนรับเข้าห้องแชทสั้นๆ และสรุปสุขภาพพอร์ตภาพรวมแบบกระชับ (อิงตัวเลขเงินสด, ผลประกอบการรวม, และทุนจากข้อมูลพอร์ต)';
        break;

      case 'deep_analysis':
        contextPrompt = `วิเคราะห์พอร์ตการลงทุนเชิงลึก โดยอิงตามสัดส่วนเป้าหมาย ให้ตอบตาม 3 หัวข้อนี้เท่านั้น:
        1. สัดส่วนสินทรัพย์ปัจจุบันเทียบกับเป้าหมาย
        2. การกระจายตัวและความเสี่ยงของพอร์ต
        3. คำแนะนำว่าสินทรัพย์กลุ่มไหนควรปรับเพิ่มหรือลด`;
        break;

      case 'portfolio_summary':
        contextPrompt = 'สรุปภาพรวมพอร์ตและผลประกอบการจากข้อมูลที่ให้มาแบบกระชับ ตรงประเด็น';
        break;

      case 'asset_analysis':
        contextPrompt = `วิเคราะห์สินทรัพย์ตามที่ผู้ใช้ระบุ: "${userMessage}" เน้นมุมมองแนวโน้ม กลยุทธ์ แนวรับ แนวต้าน แบบกระชับ`;
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
ข้อมูลพอร์ตจากระบบ: ${JSON.stringify(directPortfolioData)}
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

// ฟังก์ชันดึงข้อมูลจากพอร์ตตรงๆ (Direct Extraction ตามที่ผู้ใช้ระบุ 6 ข้อหลัก)
function extractDirectPortfolioData(portfolio) {
  if (!portfolio) {
    return { status: 'พอร์ตว่างเปล่า' };
  }

  return {
    // 1. เงินสด (สภาพคล่องในพอร์ต)
    cash: portfolio.cashBalance ?? portfolio.currentCash ?? portfolio.cash ?? 0,
    
    // 2. เงินปันผลรับ
    dividend: portfolio.dividend ?? portfolio.totalDividend ?? portfolio.dividends ?? 0,
    
    // 3. เงินที่นำไปลงทุน
    investedAmount: portfolio.investedAmount ?? portfolio.totalInvestedCost ?? portfolio.invested ?? 0,
    
    // 4. ผลประกอบการรวม
    totalGain: portfolio.totalGain ?? portfolio.performance ?? portfolio.totalProfit ?? 0,
    
    // 5. ทุนเริ่มต้นสะสม
    initialCapital: portfolio.initialCapital ?? portfolio.cumulativeInitialCapital ?? 0,
    
    // 6. รีบาลานซ์
    rebalance: portfolio.rebalance ?? portfolio.totalRebalance ?? 0,

    // ข้อมูลภาพรวมสินทรัพย์และรายชื่อย่อ
    fxRate: portfolio.fxRate || 36.5,
    holdings: Array.isArray(portfolio.holdings) ? portfolio.holdings.map(h => ({
      name: h?.name || '',
      ticker: h?.ticker || '',
      type: h?.type || '',
      quantity: h?.quantity || 0,
      currentPrice: h?.currentPrice || 0
    })) : []
  };
}
