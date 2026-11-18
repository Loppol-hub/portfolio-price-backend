// apianalyze.js - Backend สำหรับประมวลผล AI ผู้ช่วยนักบินอวกาศ
export default async function handler(req, res) {
  // CORS Headers ป้องกันปัญหาการเชื่อมต่อข้ามโดเมน
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

    // ดึง Gemini API Key จาก Environment Variable (ปลอดภัยที่สุด)
    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
      return res.status(500).json({ analysis: '⚠️ ระบบหลังบ้านยังไม่ได้ตั้งค่า API Key สำหรับ AI ครับ' });
    }

    // 1. กำหนดกฎเหล็กและความปลอดภัย (System Instruction)
    let systemInstruction = `
คุณคือนักบินอวกาศผู้ช่วยอัจฉริยะด้านการลงทุน โทนเสียงอบอุ่น เป็นกันเอง สไตล์อวกาศ กระชับ ตรงประเด็น ไม่เยิ่นเย้อ
กฎเหล็กเคร่งครัด (สำคัญมาก):
1. ห้ามแต่งข้อมูล ตัวเลข หรือสร้างข่าวเท็จขึ้นมาเองเด็ดขาด (No Hallucination)
2. หากไม่มีข้อมูล หรือไม่มั่นใจ ให้ตอบตามตรงว่า "ไม่มีข้อมูลยืนยันในระบบ"
3. ข้อมูลข่าวสารหรือบทวิเคราะห์ ต้องมาจากแหล่งข่าวหรือข้อมูลที่เชื่อถือได้เท่านั้น พร้อมระบุแหล่งที่มา (Source) ทุกครั้ง
4. หากเป็นข้อมูลหรือข่าวสารจากต่างประเทศ ต้องแปลเป็นภาษาไทยที่สละสลวยและเข้าใจง่าย
5. กรณีวิเคราะห์ DR (เช่น CATL01) ให้สืบค้นและอิงข้อมูลจากบริษัทแม่หรือธุรกิจจริง (เช่น Contemporary Amperex Technology)
6. สำหรับทองคำและคริปโต ให้เน้นมุมมองการเก็งกำไรระยะสั้น หาจังหวะซื้อขาย แนวรับ แนวต้าน ไม่ใช่การถือยาวเพื่อสะสม
    `.trim();

    // ผสาน Custom Prompt ที่ผู้ใช้ตั้งค่าเฉพาะตัว
    if (customPrompt) {
      systemInstruction += `\n\nกติกาและขอบเขตเพิ่มเติมจากผู้ใช้:\n${customPrompt}`;
    }

    // 2. จัดการไฟล์คู่มือ/ข้อมูลที่ผู้ใช้อัปโหลดให้อ่าน (File Context)
    let fileContext = '';
    if (fileContent) {
      fileContext = `\n\n[คู่มือ/ข้อมูลอ้างอิงเฉพาะทางที่ผู้ใช้อัปโหลดให้เรียนรู้]:\n${fileContent}`;
    }

    // 3. จัดเตรียมบริบทข้อมูลพอร์ตและการกระทำ (Action Handling)
    let contextPrompt = '';
    
    switch (action) {
      case 'greeting':
        contextPrompt = 'รายงานตัวทักทายผู้การประจำวัน พร้อมสรุปสุขภาพพอร์ตสั้นๆ และแจ้งเตือนหากมีสินทรัพย์ตัวไหนในพอร์ตราคาตกหนักหรือมีข่าวผลกระทบสำคัญ (อ้างอิงจากข้อมูลพอร์ตด้านล่าง)';
        break;
      case 'deep_analysis':
        contextPrompt = 'วิเคราะห์พอร์ตการลงทุนเชิงลึก ประเมินความเสี่ยง การกระจายความสินทรัพย์ และคำแนะนำในการปรับพอร์ต';
        break;
      case 'portfolio_summary':
        contextPrompt = 'สรุปภาพรวมพอร์ตประจำเดือนนี้: มีการซื้อขายสินทรัพย์ไปกี่ตัว อะไรบ้าง, เป็นจำนวนเงินรวมเท่าไหร่, และกำไร/ขาดทุนรวมทั้งหมดเท่าไหร่ (อ้างอิงจาก tradeLogs และ cashLedger ถ้ามี)';
        break;
      case 'asset_analysis':
        contextPrompt = `วิเคราะห์สินทรัพย์ตามที่ผู้ใช้ระบุ: "${userMessage}" (หากเป็น DR ให้ระบุบริษัทธุรกิจแม่จริง เช่น CATL01 คือ Contemporary Amperex Technology หากเป็นทองคำหรือคริปโตให้เน้นกลยุทธ์เก็งกำไร แนวรับ แนวต้าน)`;
        break;
      case 'news_analysis':
        contextPrompt = `วิเคราะห์สถานการณ์/เศรษฐกิจมหภาคและภูมิรัฐศาสตร์ (อเมริกา, จีน, เวียดนาม, ไทย) ตามหัวข้อ: "${userMessage}" ที่มีผลกระทบโดยตรงต่อพอร์ต พร้อมระบุแหล่งที่มาและแปลไทย`;
        break;
      case 'chat':
      default:
        contextPrompt = userMessage || 'ให้คำปรึกษาทั่วไปเกี่ยวกับการลงทุน';
        break;
    }

    const fullUserPrompt = `
ข้อมูลพอร์ตปัจจุบันของผู้ใช้: ${JSON.stringify(portfolio || {})}
${fileContext}

เป้าหมายการทำงาน/คำถาม: ${contextPrompt}
    `.trim();

    // 4. เรียกใช้งาน Google Gemini API (ใช้โมเดลมาตรฐานที่รองรับการวิเคราะห์)
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: `${systemInstruction}\n\n${fullUserPrompt}` }] }
        ],
        generationConfig: {
          temperature: 0.2, // ลดความเพี้ยน ป้องกันการแต่งเรื่องเอง
          maxOutputTokens: 1000,
        }
      })
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || 'เกิดข้อผิดพลาดจาก Gemini API');
    }

    const aiReply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'สัญญาณจากฐานทัพขาดหาย ไม่ได้รับข้อมูลตอบกลับครับ';

    return res.status(200).json({ analysis: aiReply });

  } catch (error) {
    console.error('[API Error]:', error);
    return res.status(500).json({ 
      analysis: '⚠️ เกิดข้อผิดพลาดในการประมวลผลของระบบ AI กรุณาตรวจสอบการตั้งค่า API Key อีกครั้งครับ' 
    });
  }
}
