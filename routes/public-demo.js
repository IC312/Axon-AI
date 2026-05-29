const router = require('express').Router();
const Groq = require('groq-sdk');

const AI_MODEL = 'qwen/qwen3-32b';
const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
].filter(Boolean);

let currentKeyIdx = 0;
const ipWindowMap = new Map(); // ip -> { count, resetAt }

function checkIpRateLimit(ip) {
  const now = Date.now();
  const entry = ipWindowMap.get(ip);
  if (!entry || now > entry.resetAt) {
    ipWindowMap.set(ip, { count: 1, resetAt: now + 60 * 1000 });
    return true;
  }
  if (entry.count >= 12) return false;
  entry.count += 1;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipWindowMap.entries()) {
    if (now > entry.resetAt) ipWindowMap.delete(ip);
  }
}, 5 * 60 * 1000);

async function createCompletionWithFailover(payload) {
  if (!GROQ_KEYS.length) {
    const err = new Error('Thiếu GROQ API key');
    err.status = 503;
    throw err;
  }

  let lastErr = null;
  const startIdx = currentKeyIdx;

  for (let attempt = 0; attempt < GROQ_KEYS.length; attempt++) {
    const keyIdx = (startIdx + attempt) % GROQ_KEYS.length;
    try {
      const client = new Groq.Groq({ apiKey: GROQ_KEYS[keyIdx] });
      const res = await client.chat.completions.create(payload);
      currentKeyIdx = keyIdx;
      return res;
    } catch (err) {
      lastErr = err;
      const canSwitch =
        err.status === 401 ||
        err.status === 403 ||
        err.status === 429 ||
        (typeof err.message === 'string' &&
          (err.message.includes('rate_limit') ||
            err.message.includes('quota') ||
            err.message.includes('invalid_api_key') ||
            err.message.includes('Unauthorized')));
      if (canSwitch && attempt < GROQ_KEYS.length - 1) continue;
      throw err;
    }
  }

  throw lastErr || new Error('Không thể kết nối AI');
}

function sanitizeText(s, max = 1000) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, max);
}

function stripThinkBlocks(text) {
  let s = String(text || '');
  s = s.replace(/<think>[\s\S]*?<\/redacted_thinking>/gi, '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/&lt;think&gt;[\s\S]*?&lt;\/think&gt;/gi, '');

  const openIdx = s.search(/<think>/i);
  if (openIdx !== -1) {
    const tail = s.slice(openIdx);
    if (!/<\/redacted_thinking>|<\/think>/i.test(tail)) {
      s = s.slice(0, openIdx);
    } else {
      s = s.replace(/<think>[\s\S]*$/gi, '');
    }
  }

  return s.trim();
}

function messageContent(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

function extractAssistantReply(choice) {
  const raw = messageContent(choice?.message);
  const reply = stripThinkBlocks(raw);
  if (reply) return reply;

  const trimmed = String(raw || '').trim();
  if (trimmed && !/<think>/i.test(trimmed)) return trimmed;

  return '';
}

async function callOnce(messages, extra = {}) {
  const payload = {
    model: AI_MODEL,
    messages,
    temperature: 0.45,
    top_p: 0.95,
    max_completion_tokens: 2048,
    ...extra,
  };
  const completion = await createCompletionWithFailover(payload);
  const choice = completion?.choices?.[0];
  const reply = extractAssistantReply(choice);
  return { reply, choice, raw: messageContent(choice?.message) };
}

async function generateDemoReply(messages) {
  const strategies = [
    { label: 'none', extra: { reasoning_effort: 'none' } },
    { label: 'default+strip', extra: { reasoning_effort: 'default' } },
    { label: 'plain', extra: {} },
  ];

  let lastDiag = '';

  for (const { label, extra } of strategies) {
    try {
      let { reply, choice, raw } = await callOnce(messages, extra);
      lastDiag = `${label}: raw=${raw.length} finish=${choice?.finish_reason || '?'}`;

      if (!reply) {
        console.warn('[Public Demo] empty extract', lastDiag, raw.slice(0, 120));
        continue;
      }

      if (choice?.finish_reason === 'length' && reply.length > 0) {
        try {
          const cont = await callOnce(
            [
              ...messages,
              { role: 'assistant', content: reply },
              {
                role: 'user',
                content:
                  'Hay tiep tuc cau tra loi dung cho bi ngat (khong lap lai phan da viet).',
              },
            ],
            { reasoning_effort: 'none', temperature: 0.35 }
          );
          if (cont.reply) reply = `${reply}\n${cont.reply}`;
        } catch (contErr) {
          console.warn('[Public Demo] continuation failed:', contErr.message);
        }
      }

      return reply;
    } catch (err) {
      lastDiag = `${label}: err ${err.status || ''} ${err.message}`;
      console.warn('[Public Demo] strategy failed', lastDiag);
      if (err.status === 400 || err.status === 422) continue;
      throw err;
    }
  }

  console.error('[Public Demo] all strategies failed', lastDiag);
  return '';
}

function detectLanguage(input) {
  const t = String(input || '').trim();
  if (!t) return 'vi';

  if (/[\u4e00-\u9fff]/.test(t)) return 'zh';
  if (/[\u3040-\u30ff]/.test(t)) return 'ja';
  if (/[\uac00-\ud7af]/.test(t)) return 'ko';

  const viDiacritics = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;
  const viKeywords = /\b(giai|giải|toan|toán|van|văn|hoc|học|bai|bài|phuong|phương|trinh|trình|tinh|tính|xin chao|chao ban|giup|giúp)\b/i;
  if (viDiacritics.test(t) || viKeywords.test(t)) return 'vi';

  return 'en';
}

function buildSystemPrompt(language) {
  const langRule =
    language === 'vi'
      ? 'Bat buoc tra loi bang tieng Viet, khong chen tieng Anh.'
      : language === 'en'
        ? 'Respond strictly in English.'
        : `Respond strictly in language code "${language}".`;

  return [
    'Ban la gia su AI cho hoc sinh THCS Viet Nam.',
    'Tra loi ngan gon, ro rang, tung buoc, than thien, uu tien de hieu.',
    langRule,
    'Tuyet doi khong duoc in ra qua trinh suy nghi noi bo, khong duoc xuat think tags hay chain-of-thought.',
    'Chi dua ra cau tra loi cuoi cung cho hoc sinh.',
    'Co the dung markdown nhe (**, danh sach) va cong thuc LaTeX ($...$) khi can cho toan hoc; moi cong thuc phai dong cap $ day du.',
    'Uu tien cau tra loi vua du, khong viet dai dong neu khong can.',
  ].join(' ');
}

router.post('/chat', async (req, res) => {
  try {
    if (!GROQ_KEYS.length) {
      return res.status(503).json({
        error: 'Demo AI chưa được cấu hình API trên server. Vui lòng liên hệ quản trị viên.',
      });
    }

    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    if (!checkIpRateLimit(ip)) {
      return res.status(429).json({ error: 'Demo đang quá tải, vui lòng thử lại sau 1 phút.' });
    }

    const message = sanitizeText(req.body?.message, 700);
    const history = Array.isArray(req.body?.history) ? req.body?.history : [];
    if (!message) {
      return res.status(400).json({ error: 'Tin nhắn trống.' });
    }

    const cleanedHistory = history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-6)
      .map((m) => ({ role: m.role, content: stripThinkBlocks(sanitizeText(m.content, 2000)) }))
      .filter((m) => m.content);

    const language = detectLanguage(message);

    const reply = await generateDemoReply([
      { role: 'system', content: buildSystemPrompt(language) },
      ...cleanedHistory,
      { role: 'user', content: message },
    ]);

    if (!reply) {
      return res.status(502).json({
        error:
          'Model AI tạm thời không trả lời được (có thể do quá tải hoặc hết quota Groq). Bạn thử lại sau vài giây.',
      });
    }

    return res.json({ reply, model: AI_MODEL });
  } catch (err) {
    console.error('[Public Demo AI Error]', err.status, err.message);
    if (err.status === 429) {
      return res.status(429).json({ error: 'Demo AI đang quá tải, vui lòng thử lại sau 1 phút.' });
    }
    if (err.status === 503) {
      return res.status(503).json({ error: 'Demo AI chưa được cấu hình API trên server.' });
    }
    return res.status(err.status || 500).json({
      error: 'Demo AI tạm thời gặp sự cố. Bạn thử lại sau ít phút nhé.',
    });
  }
});

module.exports = router;
