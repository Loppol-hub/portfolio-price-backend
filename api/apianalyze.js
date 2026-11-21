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

    // 2. กำหนดกฎการตอบ: เน้นกระชับ ตรงประเด็น ขอเนื้อๆ ไม่เอาน้ำ ห้ามทักทายซ้ำซาก
    let systemInstruction = `
คุณคือผู้ช่วยอัจฉริยะด้านการลงทุน โทนเสียงกระชับ เป็นมืออาชีพ ตรงประเด็น "ขอเนื้อๆ ไม่เอาน้ำ"
วันที่และเวลาปัจจุบัน (Asia/Bangkok): ${currentTimeStr} (ห้ามเดาวันที่เอง)

กฎเหล็กเคร่งครัด:
1. ห้ามใส่คำทักทายซ้ำซาก (เช่น "สวัสดีครับนักเดินทาง...") หรือเล่นบทบาทสมมติซ้ำซ้อนในทุกครั้งที่กดปุ่ม คำทักทายให้มีเฉพาะตอนเปิดแชทครั้งแรกเท่านั้น
2. ห้ามสาธยายรายชื่อหุ้นและจำนวนหุ้นทีละตัวแบบเยิ่นเย้อ ให้สรุปวิเคราะห์เป็นภาพรวมตามหมวดหมู่สินทรัพย์ เว้นแต่ผู้ใช้จะถามเจาะจง
3. ห้ามแต่งข้อมูล ตัวเลข หรือสร้างข่าวเท็จขึ้นมาเองเด็ดขาด (No Hallucination)
4. หากไม่มีข้อมูล ให้ตอบตามตรงว่า "ไม่มีข้อมูลยืนยันในระบบ"
    `.trim();

    if (customPrompt) {
      systemInstruction += `\n\nกติกาเพิ่มเติมจากผู้ใช้:\n${customPrompt}`;
    }

    let fileContext = fileContent ? `\n\n[ข้อมูลอ้างอิงจากไฟล์]:\n${fileContent}` : '';

    // 3. ปรับแต่งโครงสร้างคำสั่งของแต่ละปุ่มให้ตรงตามความต้องการ
    let contextPrompt = '';
    
    switch (action) {
      case 'greeting':
        contextPrompt = 'ทักทายสั้นๆ 1 ประโยค แล้วสรุปสถานะพอร์ตวันนี้ไม่เกิน 4 บรรทัด: มูลค่ารวม, กำไร/ขาดทุนที่ยังไม่รับรู้ (บาทและ %), สัดส่วนเงินสด, และสินทรัพย์ที่ขึ้น/ลงมากที่สุด';
        break;

      case 'deep_analysis':
        contextPrompt = `วิเคราะห์พอร์ตการลงทุนเชิงลึก ให้ตอบตาม 6 หัวข้อนี้อย่างเคร่งครัด:
        1. ภาพรวมพอร์ต: มูลค่ารวม ต้นทุน กำไร/ขาดทุน (บาท/%) ณ วันที่ปัจจุบัน
        2. สัดส่วนสินทรัพย์: แยกตามประเภท (หุ้นไทย/หุ้นนอก/กองทุน/ทอง/คริปโต/เงินสด) พร้อมระบุว่าประเภทไหนมากสุด
        3. ความกระจุกตัว: 
           - สัดส่วนเป้าหมายที่ตั้งไว้ (หุ้นไทย 50%, หุ้นนอก+DR 30%, ทองคำ 10%, คริปโต 10%) หากกลุ่มไหนเกินให้แจ้งเตือน
           - สินทรัพย์รายตัวที่มีสัดส่วนเกิน 20% ของพอร์ต (ถ้ามี) ระบุชื่อและ %
           - 3 อันดับแรกรวมกันกี่ %
           - กลุ่มอุตสาหกรรมที่กระจุกตัว (จากฟิลด์ industry)
           - หากมีหุ้นต่างประเทศหรือ DR หลายตัวในธีมเดียวกัน (เช่น เทคโนโลยีสหรัฐฯ) ให้ชี้ว่าซ้อนทับกัน
        4. ความเสี่ยงหลัก: จัดลำดับ 3 ข้อ แต่ละข้อมีเหตุผลสั้นๆ (ความเสี่ยงตลาด, สภาพคล่อง/เงินสดต่ำหรือสูงเกินไป, ความผันผวนของคริปโต/ทอง, ค่าเงิน, ค่าธรรมเนียม)
        5. จุดแข็งของพอร์ต: 1-2 ข้อ
        6. ข้อพิจารณาปรับพอร์ต: 1-3 ข้อ เรียงตามความสำคัญ แต่ละข้อบอกเหตุผลและสิ่งที่ควรระวัง (เช่น สัดส่วน, จังหวะราคา)`;
        break;

      case 'portfolio_summary':
        contextPrompt = 'สรุปภาพรวมผลตอบแทนประจำเดือนนี้: อัตรากำไร/ขาดทุนรวมจากเงินต้นทั้งหมด, การเติบโตเทียบกับเดือนก่อนหน้า และสรุปภาพรวมการซื้อขายแบบกระชับ ตรงประเด็น';
        break;

      case 'asset_analysis':
        contextPrompt = `วิเคราะห์สินทรัพย์ตามที่ผู้ใช้ระบุ: "${userMessage}" เน้นมุมมองแนวโน้ม กลยุทธ์ แนวรับ แนวต้าน หรือข้อมูลบริษัทแม่ (กรณี DR) แบบกระชับ`;
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
ข้อมูลพอร์ตปัจจุบันของผู้ใช้: ${JSON.stringify(portfolio || {})}
${fileContext}

คำสั่ง: ${contextPrompt}
    `.trim();

    // 4. เรียกใช้งาน Gemini API (ใช้รุ่นที่เสถียรและรวดเร็ว)
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
        analysis: '⚠️ เซิร์ฟเวอร์ใช้เวลาตอบกลับนานเกินไป กรุณาลองใหม่อีกครั้งครับ' 
      });
    }
    console.error('[API Error]:', error);
    return res.status(200).json({ 
      analysis: `⚠️ Server Error: ${error.message}` 
    });
  }
}
