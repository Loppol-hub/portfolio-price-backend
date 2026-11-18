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

    let systemInstruction = `
คุณคือนักบินอวกาศผู้ช่วยอัจฉริยะด้านการลงทุน โทนเสียงอบอุ่น เป็นกันเอง สไตล์อวกาศ กระชับ ตรงประเด็น ไม่เยิ่นเย้อ
กฎเหล็กเคร่งครัด:
1. ห้ามแต่งข้อมูล ตัวเลข หรือสร้างข่าวเท็จขึ้นมาเองเด็ดขาด
2. หากไม่มีข้อมูล ให้ตอบตามตรงว่า "ไม่มีข้อมูลยืนยันในระบบ"
3. ข้อมูลต้องมาจากแหล่งที่มาที่น่าเชื่อถือ พร้อมระบุ Source ทุกครั้ง
    `.trim();

    if (customPrompt) {
      systemInstruction += `\n\nกติกาเพิ่มเติมจากผู้ใช้:\n${customPrompt}`;
    }

    let fileContext = fileContent ? `\n\n[ข้อมูลอ้างอิงจากไฟล์]:\n${fileContent}` : '';
    let contextPrompt = userMessage || 'รายงานตัวทักทายผู้การประจำวัน';

    const fullUserPrompt = `
ข้อมูลพอร์ตปัจจุบัน: ${JSON.stringify(portfolio || {})}
${fileContext}

คำสั่ง: ${contextPrompt}
    `.trim();

    // เปลี่ยนมาใช้ gemini-3.5-flash-lite เพื่อรองรับ High Demand และป้องกันค้าง
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

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
        analysis: '⚠️ เซิร์ฟเวอร์ใช้เวลาตอบกลับนานเกินไป (High Demand) กรุณาลองใหม่อีกครั้งครับ' 
      });
    }
    console.error('[API Error]:', error);
    return res.status(200).json({ 
      analysis: `⚠️ Server Error: ${error.message}` 
    });
  }
}
