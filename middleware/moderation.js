'use strict';
const Groq = require('groq-sdk');

const MODERATION_KEYS = [
  process.env.GROQ_MOD_KEY_1,
  process.env.GROQ_MOD_KEY_2,
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
].filter(Boolean);
let _modKeyIdx = 0;

// ── Keyword pre-filter (không cần API) ──────────────
function normalizeForFilter(s) {
  return s.toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's');
}

const BANNED_PATTERNS = [
  /địt|djt|d[i1]t/, /lồn|lon|l[o0]n/, /cặc|cac|c[a4]c/,
  /buồi|bu[o0]i|buo[i1]/, /đéo|deo|đ[e3]o/, /vkl|vcl|clm|cmnr/,
  /đmm|đmcs|dmm|dmc(?!s)/, /đcm|dcm/, /mẹmày|memay|mémày/,
  /conmẹ|conme|concho|concặc/, /địtmẹ|djtme/, /đụ|dụ(?=.{0,3}(mẹ|me|má|ma))/,
  /đútmẹ|dutme/, /súcvật|sucvat/, /đồchó|docho/,
  /\bf+u+c+k+\b/, /\bs+h+i+t+\b/, /\bb+i+t+c+h+\b/, /\ba+s+s+h+o+l+e\b/,
  /\bc+u+n+t\b/, /\bd+i+c+k\b/, /\bp+u+s+s+y\b/,
  // Nội dung tiêu cực, phủ nhận việc học
  /học\s*(để|de|lam|làm)\s*(gì|gi|j)/, /học\s*(làm|lam)\s*(gì|gi|j)/,
  /học\s*(vô|vo)\s*(ích|ich)/, /học\s*(chán|chan|chán\s*vcl|chán\s*vl)/,
  /bỏ\s*học\s*(thôi|thui|đi)/, /không\s*muốn\s*học/,
  /học\s*(mà|ma)\s*(làm|lam)\s*(gì|gi|j)/, /học\s*(có|co)\s*(ích|ich)\s*(gì|gi|j)\s*(đâu|dau)/,
];

function keywordBlock(text) {
  const norm = normalizeForFilter(text);
  for (const pat of BANNED_PATTERNS) {
    if (pat.test(norm) || pat.test(text.toLowerCase())) {
      return { blocked: true, reason: 'chứa ngôn ngữ tục tĩu hoặc chửi bậy' };
    }
  }
  return { blocked: false };
}

// ── Phát hiện tiêu đề là ký tự ngẫu nhiên ───────────────────────────────────
// Phát hiện dựa trên 2 tín hiệu:
//   1. Từ dài ≥ 9 ký tự có ≥ 75% chữ HOA (sau khi bỏ dấu) — bắt cả "ÙHYSAJWLAIDHef"
//      (viết tắt hợp lệ như THPTQG thường ≤ 6 ký tự nên không bị ảnh hưởng)
//   2. Cụm phụ âm liên tiếp ≥ 6 ký tự — không tồn tại trong tiếng Việt hay tiếng Anh bình thường
function isTitleGibberish(title) {
  if (!title || !title.trim()) return false;
  // Tiêu đề quá ngắn (1 từ ≤ 10 ký tự) không đủ thông tin — vd: "toán", "lý", "văn"
  const trimmed = title.trim();
  if (!/\s/.test(trimmed) && trimmed.length <= 10) return true;
  const words = trimmed.split(/\s+/);
  for (const word of words) {
    // Bỏ dấu thanh tiếng Việt, giữ lại chữ cái
    const base = word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z]/g, '');
    if (base.length < 5) continue;
    // Từ dài ≥ 9 ký tự với ≥ 75% chữ HOA — bắt "UHYSAJWLAIDHef" (12/14 = 85%)
    if (base.length >= 9 && (base.match(/[A-Z]/g) || []).length / base.length >= 0.75) return true;
    // Cụm phụ âm liên tiếp ≥ 6 ký tự
    if (/[bcdfghjklmnpqrstvwxyz]{6,}/i.test(base)) return true;
  }
  return false;
}

// ── Kiểm duyệt AI ───────────────────────────────────
async function moderateText(text, title) {
  // 1. Keyword pre-filter
  const kw = keywordBlock(text);
  if (kw.blocked) return { allowed: false, reason: kw.reason };

  // 2. Gibberish title pre-filter (không cần gọi API)
  if (title !== undefined && isTitleGibberish(title)) {
    return { allowed: false, reason: 'Tiêu đề bài viết chứa ký tự ngẫu nhiên, không có ý nghĩa' };
  }

  if (!MODERATION_KEYS.length) return { allowed: true, reason: '' };

  // 3. AI moderation
  const titleSection = title !== undefined
    ? `\nTIÊU ĐỀ BÀI VIẾT: "${title.slice(0, 100)}"\nNỘI DUNG:\n`
    : '';
  const titleRule = title !== undefined
    ? `- Tiêu đề không mô tả đúng nội dung bài viết (ví dụ: tiêu đề là tên một môn học nhưng nội dung hỏi về môn khác hoàn toàn không liên quan)\n`
    : '';
  const prompt = `Bạn là hệ thống kiểm duyệt cho nền tảng học tập dành cho học sinh phổ thông.
Phân tích và trả lời JSON: {"allowed": true/false, "reason": "lý do nếu bị chặn"}

CHẶN nếu:
- Chứa ngôn ngữ tục tĩu, chửi bậy, xúc phạm (kể cả dạng viết tắt hay lồng ghép)
- Nội dung quấy rối, đe dọa, bạo lực, khiêu dâm
- Bàn luận về game, giải trí, phim ảnh, mạng xã hội không liên quan học tập
- Tiêu đề hoặc nội dung là chuỗi ký tự ngẫu nhiên, vô nghĩa, spam
${titleRule}- Nội dung tiêu cực, phủ nhận việc học: "học làm gì", "học vô ích", "bỏ học", "chán học", "không muốn học"

CHO PHÉP:
- Câu hỏi về bài học, môn học, bài tập, kiến thức khoa học, lịch sử, văn học, toán, lý, hóa...
- Nhờ giải thích khái niệm, phương pháp học tập
- Than thở về độ khó của bài tập hoặc áp lực thi cử (nhưng không phủ nhận việc học)
- Hỏi về hướng nghiệp, thi cử, trường lớp

${titleSection}"""
${text.slice(0, 800)}
"""

Trả về JSON thuần túy.`;

  let lastErr = null;
  for (let attempt = 0; attempt < MODERATION_KEYS.length; attempt++) {
    const keyIdx = (_modKeyIdx + attempt) % MODERATION_KEYS.length;
    try {
      const client = new Groq.Groq({ apiKey: MODERATION_KEYS[keyIdx] });
      const completion = await client.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        max_completion_tokens: 100,
        temperature: 0,
      });
      _modKeyIdx = keyIdx;
      let raw = completion.choices?.[0]?.message?.content || '{}';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      const result = JSON.parse(jsonMatch[0]);
      return { allowed: result.allowed !== false, reason: result.reason || '' };
    } catch (err) {
      lastErr = err;
      const isKeyErr = err.status === 401 || err.status === 403 || err.status === 429;
      if (isKeyErr && attempt < MODERATION_KEYS.length - 1) {
        _modKeyIdx = (keyIdx + 1) % MODERATION_KEYS.length;
        continue;
      }
      console.warn('[Moderation]', err.message);
      return { allowed: true, reason: '' };
    }
  }
  console.warn('[Moderation] All keys failed:', lastErr?.message);
  return { allowed: true, reason: '' };
}

module.exports = { moderateText, keywordBlock, isTitleGibberish };
