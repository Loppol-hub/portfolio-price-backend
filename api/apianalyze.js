// apianalyze.js - Backend สำหรับประมวลผล AI (รองรับ Google Search และแหล่งข้อมูลที่น่าเชื่อถือ)
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

    // 1. กำหนดกฎการตอบ: กระชับ ตรงประเด็น พร้อมกฎการค้นหาข้อมูลและแปลภาษา
    let systemInstruction = `
คุณคือผู้ช่วยอัจฉริยะด้านการลงทุน โทนเสียงกระชับ เป็นมืออาชีพ ตรงประเด็น "ขอเนื้อๆ ไม่เอาน้ำ"
กฎเหล็กเคร่งครัด:
1. ห้ามใส่คำทักทายซ้ำซาก หรือเล่นบทบาทสมมติซ้ำซ้อนในทุกครั้งที่กดปุ่ม คำทักทายให้มีเฉพาะตอนเปิดแชทครั้งแรกเท่านั้น
2. ต้องค้นหาข้อมูลออนไลน์และอ้างอิงจากสำนักข่าวหรือแหล่งข้อมูลทางการที่น่าเชื่อถือที่สุดเสมอ (เช่น Bloomberg, Reuters, ทางการ, ตลาดหลักทรัพย์) และต้องเป็นข้อมูลปัจจุบันที่สุด
3. หากข้อมูล ข่าวสาร หรือบทวิเคราะห์เป็นภาษาต่างประเทศ ให้แปลและสรุปเป็นภาษาไทยที่สละสลวย ชัดเจน และเข้าใจง่าย
4. ห้ามแต่งข้อมูล ตัวเลข หรือสร้างข่าวเท็จขึ้นมาเองเด็ดขาด (No Hallucination) หากไม่มีข้อมูล ให้ตอบตามตรงว่า "ไม่มีข้อมูลยืนยันในระบบ"
5. ห้ามสาธยายรายชื่อหุ้นและจำนวนหุ้นทีละตัวแบบเยิ่นเย้อ ให้สรุปวิเคราะห์เป็นภาพรวมตามหมวดหมู่สินทรัพย์ เว้นแต่ผู้ใช้จะถามเจาะจง
    `.trim();

    if (customPrompt) {
      systemInstruction += `\n\nกติกาเพิ่มเติมจากผู้ใช้:\n${customPrompt}`;
    }

    let fileContext = fileContent ? `\n\n[ข้อมูลอ้างอิงจากไฟล์]:\n${fileContent}` : '';

    // 2. ปรับแต่งโครงสร้างคำสั่งของแต่ละปุ่มให้ดึงข้อมูลออนไลน์ประกอบ
    let contextPrompt = '';
    
    switch (action) {
      case 'greeting':
        contextPrompt = 'ทักทายต้อนรับเข้าห้องแชทสั้นๆ และสรุปสุขภาพพอร์ตภาพรวมแบบกระชับ (ไม่เยิ่นเย้อ)';
        break;

      case 'deep_analysis':
        contextPrompt = `วิเคราะห์พอร์ตการลงทุนเชิงลึก โดยอิงตามสัดส่วนเป้าหมายที่ผู้ใช้ตั้งไว้ (หุ้นไทย 50%, หุ้นต่างประเทศ 30%, ทองคำ 10%, คริปโต 10%) พร้อมค้นหาข้อมูลแนวโน้มตลาดปัจจุบันประกอบ ให้ตอบตาม 3 หัวข้อนี้:
        1. สัดส่วนสินทรัพย์ปัจจุบันเทียบกับเป้าหมาย
        2. การกระจายตัวและความเสี่ยงของพอร์ต
        3. คำแนะนำการปรับพอร์ตตามภาวะตลาดปัจจุบัน`;
        break;

      case 'portfolio_summary':
        contextPrompt = 'สรุปภาพรวมผลตอบแทนประจำเดือนนี้: อัตรากำไร/ขาดทุนรวมจากเงินต้นทั้งหมด, การเติบโตเทียบกับเดือนก่อนหน้า และสรุปภาพรวมการซื้อขายแบบกระชับ ตรงประเด็น';
        break;

      case 'asset_analysis':
        contextPrompt = `วิเคราะห์สินทรัพย์ตามที่ผู้ใช้ระบุ: "${userMessage}" ค้นหาข้อมูลราคา ข่าวสาร หรือผลประกอบการล่าสุดจากเว็บ (แปลเป็นภาษาไทยหากเป็นข้อมูลต่างประเทศ) เน้นมุมมองแนวโน้ม กลยุทธ์ แนวรับ แนวต้าน หรือข้อมูลบริษัทแม่ (กรณี DR) แบบกระชับ`;
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
ข้อมูลพอร์ตปัจจุบันของผู้ใช้: ${JSON.stringify(portfolio || {})}
${fileContext}

คำสั่ง: ${contextPrompt}
    `.trim();

    // 3. เรียกใช้งาน Gemini API พร้อมเปิดใช้งานเครื่องมือค้นหา Google Search
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
      tools: [{ googleSearch: {} }] // เปิดใช้งานการค้นหาข้อมูลออนไลน์
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // เพิ่มเวลา Timeout เล็กน้อยเผื่อขั้นตอนการค้นหาเว็บ

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

    // 4. ดึงข้อมูลแหล่งที่มา (Grounding Sources) จาก Google Search มาแสดงผล
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
