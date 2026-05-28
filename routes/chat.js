const router       = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { getConnection, getChatModels } = require('../db');

router.use(authMiddleware);

// ── Rate limit: 30 tin nhắn/phút mỗi tài khoản ───────
const rateLimitMap = new Map(); // userId → { count, resetAt }

function checkRateLimit(userId) {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now > entry.resetAt) {
    // Reset mỗi 1 phút
    rateLimitMap.set(userId, { count: 1, resetAt: now + 60 * 1000 });
    return true;
  }

  if (entry.count >= 30) return false;

  entry.count++;
  return true;
}

// Dọn dẹp Map mỗi 5 phút để tránh memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000);

async function models(req) {
  const conn = await getConnection(req.user.grade);
  return getChatModels(conn);
}

// ── Tạo conversation mới ──────────────────────────────
router.post('/conversations', async (req, res) => {
  try {
    const { Conversation } = await models(req);
    const conv = await Conversation.create({
      userId: req.user.id,
      title:  (req.body.title || 'Hội thoại mới').slice(0, 100),
    });
    res.status(201).json(conv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Danh sách conversations ───────────────────────────
router.get('/conversations', async (req, res) => {
  try {
    const { Conversation } = await models(req);
    const convs = await Conversation.find({ userId: req.user.id });
    res.json(convs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Đổi tên conversation ──────────────────────────────
router.patch('/conversations/:id', async (req, res) => {
  try {
    const { Conversation } = await models(req);
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'Thiếu title' });
    const conv = await Conversation.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { title: title.slice(0, 80) },
      { new: true }
    );
    if (!conv) return res.status(404).json({ error: 'Không tìm thấy' });
    res.json({ ok: true, title: conv.title });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Xoá conversation ──────────────────────────────────
router.delete('/conversations/:id', async (req, res) => {
  try {
    const { Conversation, Message } = await models(req);
    const conv = await Conversation.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (!conv) return res.status(404).json({ error: 'Không tìm thấy' });
    await Message.deleteMany({ conversationId: conv._id });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Lấy messages ──────────────────────────────────────
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const { Conversation, Message } = await models(req);
    const conv = await Conversation.findOne({ _id: req.params.id, userId: req.user.id });
    if (!conv) return res.status(404).json({ error: 'Không tìm thấy' });
    const msgs = await Message.find({ conversationId: conv._id });
    res.json(msgs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Lưu 1 tin nhắn ───────────────────────────────────
router.post('/conversations/:id/messages', async (req, res) => {
  try {
    // Kiểm tra rate limit trước
    if (!checkRateLimit(req.user.id)) {
      return res.status(429).json({ error: 'Bạn nhắn tin quá nhanh! Vui lòng chờ một chút rồi thử lại.' });
    }

    const { Conversation, Message } = await models(req);
    const { role, content } = req.body;
    
    // Validate role
    if (!['user', 'assistant'].includes(role)) {
      return res.status(400).json({ error: 'role không hợp lệ' });
    }
    
    // Validate content
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Thiếu nội dung' });
    }
    if (content.length > 5000) {
      return res.status(400).json({ error: 'Nội dung quá dài (tối đa 5000 ký tự)' });
    }
    
    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      return res.status(400).json({ error: 'Nội dung không được để trống' });
    }

    const conv = await Conversation.findOne({ _id: req.params.id, userId: req.user.id });
    if (!conv) return res.status(404).json({ error: 'Không tìm thấy' });

    const msg = await Message.create({ conversationId: conv._id, role, content: trimmedContent });
    await Conversation.findByIdAndUpdate(conv._id, { updatedAt: new Date() });
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Proxy AI → Groq ───────────────────────────────────
const Groq = require('groq-sdk');
const AI_MODEL = 'qwen/qwen3-32b';

// Failover multi API key: chỉ dùng 1 key tại 1 thời điểm,
// chuyển sang key tiếp theo khi key hiện tại bị lỗi.
const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
].filter(Boolean);
let _currentKeyIdx = 0;

function getGroqClient(keyIdx) {
  const idx = (keyIdx !== undefined ? keyIdx : _currentKeyIdx) % GROQ_KEYS.length;
  return new Groq.Groq({ apiKey: GROQ_KEYS[idx] });
}

// Tạo stream Groq với cơ chế failover tự động
async function createGroqStreamWithFailover(params) {
  let lastError = null;
  const startIdx = _currentKeyIdx;

  for (let attempt = 0; attempt < GROQ_KEYS.length; attempt++) {
    const keyIdx = (startIdx + attempt) % GROQ_KEYS.length;
    try {
      const client = getGroqClient(keyIdx);
      const stream = await client.chat.completions.create(params);
      // Key này hoạt động → cập nhật key hiện tại
      _currentKeyIdx = keyIdx;
      return stream;
    } catch (err) {
      lastError = err;
      const isKeyError =
        err.status === 401 || // Unauthorized
        err.status === 403 || // Forbidden
        err.status === 429 || // Rate limit / quota
        (err.message && (
          err.message.includes('rate_limit') ||
          err.message.includes('quota') ||
          err.message.includes('invalid_api_key') ||
          err.message.includes('Unauthorized')
        ));

      // 413 = request quá lớn → không đổi key, báo lỗi ngay
      const isTooBig = err.status === 413;

      if (isKeyError && !isTooBig && attempt < GROQ_KEYS.length - 1) {
        const nextIdx = (keyIdx + 1) % GROQ_KEYS.length;
        console.warn(`[AI Failover] Key #${keyIdx + 1} lỗi (${err.status || err.message}), thử Key #${nextIdx + 1}...`);
        _currentKeyIdx = nextIdx;
        continue;
      }

      // Lỗi không phải do key (mạng, server...) → không cần thử key khác
      throw err;
    }
  }

  throw lastError;
}

// Ước tính token: ~4 chars/token
function estimateTokens(s) { return Math.ceil((s || '').length / 4); }

// Giữ lại messages vừa đủ trong budget token để tránh vượt TPM Groq free tier
function truncateMessages(messages, maxInputTokens = 3800) {
  const system = messages.filter(m => m.role === 'system');
  const history = messages.filter(m => m.role !== 'system');
  if (history.length === 0) return messages;

  let budget = maxInputTokens - system.reduce((s, m) => s + estimateTokens(m.content), 0);

  // Luôn giữ tin nhắn cuối (câu hỏi hiện tại)
  const last = history[history.length - 1];
  budget -= estimateTokens(last.content);

  // Thêm lịch sử cũ từ gần nhất đến xa nhất
  const kept = [];
  for (let i = history.length - 2; i >= 0; i--) {
    const cost = estimateTokens(history[i].content);
    if (budget - cost < 0) break;
    budget -= cost;
    kept.unshift(history[i]);
  }
  kept.push(last);
  return [...system, ...kept];
}

router.post('/ai', async (req, res) => {
  try {
    // Rate limit
    if (!checkRateLimit(req.user.id)) {
      return res.status(429).json({ error: 'Bạn nhắn tin quá nhanh! Vui lòng chờ một chút rồi thử lại.' });
    }

    const { messages, max_tokens: _mt = 2048 } = req.body;
    const temperature = Math.max(0, Math.min(2, parseFloat(req.body.temperature) || 0.6));
    const max_tokens = Math.min(_mt, 2048); // giới hạn cứng, tránh vượt TPM Groq free tier
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Thiếu dữ liệu messages' });
    }

    // Lọc bỏ bất kỳ system message nào từ client — chống prompt injection
    const clientMessages = messages.filter(m => m.role !== 'system');

    // Kiểm duyệt tin nhắn cuối của học sinh trước khi gửi lên AI
    const lastUserMsg = [...clientMessages].reverse().find(m => m.role === 'user');
    if (lastUserMsg && lastUserMsg.content) {
      const mod = await moderateText(lastUserMsg.content);
      if (!mod.allowed) {
        return res.status(422).json({
          error: `Tin nhắn không phù hợp và không thể gửi${mod.reason ? ': ' + mod.reason : ''}. Vui lòng chỉnh sửa lại.`,
          moderated: true,
        });
      }
    }

    // Cắt bớt lịch sử để giữ trong giới hạn TPM Groq
    const trimmedMessages = truncateMessages(clientMessages, 3800);

    // Streaming SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    const stream = await createGroqStreamWithFailover({
      model:               AI_MODEL,
      messages:            trimmedMessages,
      stream:              true,
      temperature,
      max_completion_tokens: max_tokens,
      top_p:               0.95,
      reasoning_effort:    'default',
      stop:                null,
    });

    let chatBuf = '';
    let chatInThink = false;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (!delta) continue;

      chatBuf += delta;
      let out = '';
      while (chatBuf.length) {
        if (chatInThink) {
          const end = chatBuf.indexOf('</think>');
          if (end === -1) { chatBuf = ''; break; }
          chatBuf = chatBuf.slice(end + 8);
          chatInThink = false;
        } else {
          const start = chatBuf.indexOf('<think>');
          if (start === -1) { out += chatBuf; chatBuf = ''; break; }
          out += chatBuf.slice(0, start);
          chatBuf = chatBuf.slice(start + 7);
          chatInThink = true;
        }
      }
      if (out) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out } }] })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    console.error('[AI Proxy Error]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Lỗi server nội bộ. Vui lòng thử lại.' });
    } else {
      res.end();
    }
  }
});

// ── Kiểm duyệt nội dung (dùng module dùng chung) ────
const { moderateText } = require('../middleware/moderation');

// ── Góp ý (ẩn danh) ──────────────────────────────────
const { FeedbackModel } = require('../db');

router.post('/feedback', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Nội dung góp ý không được để trống' });
    }
    if (content.trim().length > 2000) {
      return res.status(400).json({ error: 'Nội dung quá dài (tối đa 2000 ký tự)' });
    }

    // Kiểm duyệt nội dung
    const mod = await moderateText(content.trim());
    if (!mod.allowed) {
      return res.status(422).json({
        error: `Nội dung không phù hợp và không thể gửi${mod.reason ? ': ' + mod.reason : ''}. Vui lòng chỉnh sửa lại.`,
        moderated: true,
      });
    }

    const doc = await FeedbackModel.create({ content: content.trim(), userId: req.user.id });
    res.json({ ok: true, _id: doc._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Học sinh xem góp ý của chính mình
router.get('/feedback/mine', async (req, res) => {
  try {
    const items = await FeedbackModel.findByUser(req.user.id);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Học sinh đánh dấu đã xem phản hồi từ admin
router.post('/feedback/mark-read', async (req, res) => {
  try {
    const count = await FeedbackModel.markStudentRead(req.user.id);
    res.json({ ok: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Học sinh đánh dấu đã xem một góp ý cụ thể
router.post('/feedback/:id/mark-read', async (req, res) => {
  try {
    await FeedbackModel.markStudentReadOne(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

