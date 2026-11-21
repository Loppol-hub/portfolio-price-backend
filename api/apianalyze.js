// apianalyze.js - Backend สำหรับประมวลผล AI (พร้อมระบบย่อข้อมูลพอร์ตป้องกัน Token ลิมิต)
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
      return res.status(200).json({ analysis: '⚠️ ระบบหลังบ้านยังไม่ได้ตั้งค่า GEMINI_API_KEY บน Vercel ครับ', sources: [] });
    }

    // 1. ย่อและกรองข้อมูลพอร์ตให้กะทัดรัด ไม่ให้ Token ลิมิตเต็ม
    const leanPortfolio = summarizePortfolioForAI(portfolio);

    // 2. กำหนดกฎการตอบ
    let systemInstruction = `
คุณคือผู้ช่วยอัจฉริยะด้านการลงทุน โทนเสียงกระชับ เป็นมืออาชีพ ตรงประเด็น "ขอเนื้อๆ ไม่เอาน้ำ"
กฎเหล็กเคร่งครัด:
1. ห้ามใส่คำทักทายซ้ำซาก หรือเล่นบทบาทสมมติซ้ำซ้อนในทุกครั้งที่กดปุ่ม
2. ต้องค้นหาข้อมูลออนไลน์และอ้างอิงจากสำนักข่าวหรือแหล่งข้อมูลทางการที่น่าเชื่อถือที่สุดเสมอ และต้องเป็นข้อมูลปัจจุบันที่สุด
3. หากข้อมูล ข่าวสาร หรือบทวิเคราะห์เป็นภาษาต่างประเทศ ให้แปลและสรุปเป็นภาษาไทยที่สละสลวย ชัดเจน
4. ห้ามแต่งข้อมูล ตัวเลข หรือสร้างข่าวเท็จขึ้นมาเองเด็ดขาด (No Hallucination)
5. ห้ามสาธยายรายชื่อหุ้นและจำนวนหุ้นทีละตัวแบบเยิ่นเย้อ ให้สรุปวิเคราะห์เป็นภาพรวมตามหมวดหมู่สินทรัพย์ เว้นแต่ผู้ใช้จะถามเจาะจง
    `.trim();

    if (customPrompt) {
      systemInstruction += `\n\nกติกาเพิ่มเติมจากผู้ใช้:\n${customPrompt}`;
    }

    let fileContext = fileContent ? `\n\n[ข้อมูลอ้างอิงจากไฟล์]:\n${fileContent}` : '';

    // 3. จัดเตรียม Prompt ตาม Action
    let contextPrompt = '';
    
    switch (action) {
      case 'greeting':
        contextPrompt = 'ทักทายต้อนรับเข้าห้องแชทสั้นๆ และสรุปสุขภาพพอร์ตภาพรวมแบบกระชับ';
        break;

      case 'deep_analysis':
        contextPrompt = `วิเคราะห์พอร์ตการลงทุนเชิงลึก โดยอิงตามสัดส่วนเป้าหมายที่ผู้ใช้ตั้งไว้ พร้อมค้นหาข้อมูลแนวโน้มตลาดปัจจุบันประกอบ ให้ตอบตาม 3 หัวข้อ:
        1. สัดส่วนสินทรัพย์ปัจจุบันเทียบกับภาพรวม
        2. การกระจายตัวและความเสี่ยงของพอร์ต
        3. คำแนะนำการปรับพอร์ตตามภาวะตลาดปัจจุบัน`;
        break;

      case 'portfolio_summary':
        contextPrompt = 'สรุปภาพรวมผลตอบแทนและสถานะพอร์ตปัจจุบันแบบกระชับ ตรงประเด็น';
        break;

      case 'asset_analysis':
        contextPrompt = `วิเคราะห์สินทรัพย์ตามที่ผู้ใช้ระบุ: "${userMessage}" ค้นหาข้อมูลราคา ข่าวสาร หรือผลประกอบการล่าสุดจากเว็บ (แปลเป็นภาษาไทย) เน้นมุมมองแนวโน้ม กลยุทธ์ แนวรับ แนวต้าน แบบกระชับ`;
        break;

      case 'news_analysis':
        contextPrompt = `วิเคราะห์ผลกระทบของสถานการณ์/ข่าวต่อพอร์ต: "${userMessage}" ค้นหาข่าวสารล่าสุดจากแหล่งที่น่าเชื่อถือ (แปลเป็นภาษาไทย) สรุปผลกระทบและแนวทางรับมือสั้นๆ`;
        break;

      case 'chat':
      default:
        contextPrompt = userMessage || 'ให้คำปรึกษาทั่วไปเกี่ยวกับการลงทุนแบบกระชับ ตรงประเด็น';
        break;
    }

    const fullUserPrompt = `
ข้อมูลสรุปพอร์ตของผู้ใช้: ${JSON.stringify(leanPortfolio)}
${fileContext}

คำสั่ง: ${contextPrompt}
    `.trim();

    // 4. เรียกใช้งาน Gemini API พร้อมเปิดใช้งาน Google Search
    const modelName = 'gemini-3.5-flash-lite';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const requestBody = {
      contents: [
        { role: 'user', parts: [{ text: `${systemInstruction}\n\n${fullUserPrompt}` }] }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1000,
      },
      tools: [{ googleSearch: {} }]
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const data = await response.json();

    if (data.error) {
      return res.status(200).json({ 
        analysis: `⚠️ Google API Error: ${data.error.message || JSON.stringify(data.error)}`,
        sources: []
      });
    }

    const candidate = data.candidates?.[0];
    const aiReply = candidate?.content?.parts?.[0]?.text || 'สัญญาณจากฐานทัพขาดหาย ไม่ได้รับข้อมูลตอบกลับครับ';

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
      analysis: aiReply,
      sources: sources 
    });

  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(200).json({ 
        analysis: '⚠️ เซิร์ฟเวอร์ใช้เวลาค้นหาข้อมูลออนไลน์นานเกินไป กรุณาลองใหม่อีกครั้งครับ',
        sources: [] 
      });
    }
    console.error('[API Error]:', error);
    return res.status(200).json({ 
      analysis: `⚠️ Server Error: ${error.message}`,
      sources: [] 
    });
  }
}

// ฟังก์ชันย่อข้อมูลพอร์ตให้กะทัดรัด ป้องกัน Token ลิมิตเต็ม
function summarizePortfolioForAI(portfolio) {
  if (!portfolio) return { status: 'พอร์ตว่างเปล่า' };

  const holdings = Array.isArray(portfolio.holdings) ? portfolio.holdings : [];
  
  // สรุปข้อมูลสินทรัพย์เฉพาะตัวที่จำเป็น
  const simplifiedHoldings = holdings.map(h => ({
    name: h?.name || '',
    ticker: h?.ticker || '',
    type: h?.type || '',
    qty: parseFloat(h?.quantity) || 0,
    avgCost: parseFloat(h?.avgCost) || 0,
    currentPrice: parseFloat(h?.currentPrice) || 0,
    currency: h?.currency || 'THB'
  }));

  return {
    initialCapital: portfolio.initialCapital || 0,
    fxRate: portfolio.fxRate || 36.5,
    holdingsCount: simplifiedHoldings.length,
    holdings: simplifiedHoldings,
    // ตัดประวัติยาวๆ ออก ส่งเฉพาะภาพรวมเพื่อประหยัด Token
  };
}
