export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'POST only'
    });
  }

  try {
    const { portfolio } = req.body;

    const prompt = `
คุณเป็นผู้ช่วยวิเคราะห์และติดตามพอร์ตการลงทุน

ข้อมูลพอร์ต:

${JSON.stringify(portfolio, null, 2)}

1.กรุณาตอบเป็นภาษาไทยและใช้ศัพท์ที่เข้าใจง่าย
2.ถ้ามีข้อมูลจากเวพภายนอกอัพเดทข้อมูลให้เป็นปัจุบันที่สุดก่อนตอบ
3.ไม่เติมแต่งหรือมั่วข้อมูล 

รูปแบบ:

1. สรุปภาพรวมพอร์ต
2. จุดแข็ง
3. ความเสี่ยง
4. คำแนะนำ

ตอบไม่เกิน 300 คำ
`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    const analysis =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      'ไม่สามารถวิเคราะห์ได้';

    return res.status(200).json({
      analysis
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
}
