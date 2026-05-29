const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const { adminMiddleware } = require('../middleware/auth');
const { getConnection, getChatModels } = require('../db');
const { SchoolUserModel, EmailUserModel } = require('../db-supabase');

router.use(adminMiddleware);

// Helper: lấy chat models từ đúng DB theo grade
async function getChatDB(grade)         { const c = await getConnection(grade); return getChatModels(c); }

// Lấy chat models từ tất cả 4 khối
async function getAllChatModels() {
  const results = await Promise.all([6,7,8,9].map(g => getConnection(g).then(c => getChatModels(c))));
  return results; // [{Conversation, Message}, ...]
}

// ── Hàm sort lớp đúng thứ tự: 6A1→6A2→6A10→7A1... ──
function sortClasses(a, b) {
  const parse = s => { const m = s.match(/^(\d+)[A-Za-z]+(\d+)$/); return m ? [+m[1], +m[2]] : [0, 0]; };
  const [ag, an] = parse(a);
  const [bg, bn] = parse(b);
  return ag !== bg ? ag - bg : an - bn;
}

function sortByGivenName(a, b) {
  const last = s => (s.fullName || '').split(' ').pop();
  return last(a).localeCompare(last(b), 'vi', { sensitivity: 'base' });
}

// Xác định grade từ className
function gradeFromClass(className) {
  const m = (className || '').match(/^(\d)/);
  return m ? parseInt(m[1]) : 9;
}

// ── Stats ─────────────────────────────────────────────
router.get('/stats', async (_req, res) => {
  try {
    const User = SchoolUserModel;
    const students = await User.find({ role: 'student' });
    const classes  = [...new Set(students.map(s => s.className).filter(Boolean))];

    // Đếm conv + msg từ tất cả 4 DB khối
    const chatDBs = await getAllChatModels();
    const [convCounts, msgCounts] = await Promise.all([
      Promise.all(chatDBs.map(({ Conversation }) => Conversation.countDocuments())),
      Promise.all(chatDBs.map(({ Message }) => Message.countDocuments())),
    ]);
    const totalConvs = convCounts.reduce((a, b) => a + b, 0);
    const totalMsgs  = msgCounts.reduce((a, b) => a + b, 0);

    res.json({ totalStudents: students.length, totalClasses: classes.length, totalConvs, totalMsgs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Danh sách lớp ─────────────────────────────────────
router.get('/classes', async (_req, res) => {
  try {
    const User = SchoolUserModel;
    const students = await User.find({ role: 'student', className: { $ne: '' } });
    const classes  = [...new Set(students.map(s => s.className))].sort(sortClasses);
    res.json(classes);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Học sinh trong lớp ────────────────────────────────
router.get('/classes/:className/students', async (req, res) => {
  try {
    const User = SchoolUserModel;
    const students = await User.find({ role: 'student', className: req.params.className });
    students.sort(sortByGivenName);

    const grade = gradeFromClass(req.params.className);
    const { Conversation, Message } = await getChatDB(grade);

    const result = await Promise.all(students.map(async s => {
      const convIds = await Conversation.distinct('_id', { userId: s._id });
      return { ...s, convCount: convIds.length, msgCount: await Message.countDocuments({ conversationId: { $in: convIds } }) };
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Chi tiết 1 học sinh ───────────────────────────────
router.get('/users/:userId', async (req, res) => {
  try {
    const User = SchoolUserModel;
    const s = await User.findById(req.params.userId);
    if (!s) return res.status(404).json({ error: 'Không tìm thấy' });
    const defaultPw = s.mustChangePassword
      ? (s.dob ? s.dob.replace(/\//g, '') : '(chưa có ngày sinh)')
      : null;
    res.json({ ...s, defaultPw });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Reset mật khẩu ────────────────────────────────────
router.post('/users/:userId/reset-password', async (req, res) => {
  try {
    const User = SchoolUserModel;
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'Không tìm thấy' });
    if (user.role === 'admin') return res.status(403).json({ error: 'Không thể reset admin' });

    const defaultPw = (user.dob || '').replace(/\//g, '');
    if (!defaultPw) return res.status(400).json({ error: 'Học sinh không có ngày sinh' });

    user.passwordHash = await bcrypt.hash(defaultPw, 10);
    user.mustChangePassword = true;
    await user.save();
    res.json({ ok: true, defaultPw });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Conversations của học sinh ────────────────────────
router.get('/users/:userId/conversations', async (req, res) => {
  try {
    const User = SchoolUserModel;
    const student = await User.findById(req.params.userId);
    if (!student) return res.status(404).json({ error: 'Không tìm thấy' });

    const grade = gradeFromClass(student.className);
    const { Conversation, Message } = await getChatDB(grade);

    const convs = await Conversation.find({ userId: req.params.userId });
    const result = await Promise.all(convs.map(async c => ({
      ...c, msgCount: await Message.countDocuments({ conversationId: c._id })
    })));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Messages của hội thoại ────────────────────────────
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    // Tìm conversation trong tất cả DB khối
    const chatDBs = await getAllChatModels();
    for (const { Conversation, Message } of chatDBs) {
      const conv = await Conversation.findById(req.params.id);
      if (conv) {
        const msgs = await Message.find({ conversationId: req.params.id });
        return res.json(msgs);
      }
    }
    res.json([]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin settings ────────────────────────────────────
router.post('/settings', async (req, res) => {
  try {
    const User = SchoolUserModel;
    const { newUsername, currentPassword, newPassword } = req.body;
    if (!currentPassword) return res.status(400).json({ error: 'Vui lòng nhập mật khẩu hiện tại' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    if (!(await bcrypt.compare(currentPassword, user.passwordHash)))
      return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });

    if (newUsername && newUsername.trim()) {
      const candidate = newUsername.trim();
      const exists = await SchoolUserModel.findOne({ username: candidate });
      // Allow if it's the same user's current username
      if (exists && String(exists.id) !== String(user.id))
        return res.status(409).json({ error: 'Tên đăng nhập này đã được sử dụng' });
      user.username = candidate;
      user.fullName = candidate;
    }
    if (newPassword) {
      if (newPassword.length < 8) return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 8 ký tự' });
      if (!/[a-z]/i.test(newPassword) || !/\d/.test(newPassword))
        return res.status(400).json({ error: 'Mật khẩu phải chứa chữ cái và số' });
      user.passwordHash = await bcrypt.hash(newPassword, 10);
    }
    await user.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AI helpers (Groq) ────────────────────────────────
const Groq = require('groq-sdk');
const ADMIN_AI_MODEL = 'qwen/qwen3-32b';

const ADMIN_GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
].filter(Boolean);

let _adminKeyIdx = 0;

function isKeyError(err) {
  return (
    err.status === 401 ||
    err.status === 403 ||
    err.status === 429 ||
    (err.message && (
      err.message.includes('invalid_api_key') ||
      err.message.includes('rate_limit') ||
      err.message.includes('quota') ||
      err.message.includes('Unauthorized')
    ))
  );
}

// Non-streaming với failover tự động
async function callAI(systemPrompt, userContent, maxTokens = 600) {
  let lastError = null;
  const startIdx = _adminKeyIdx;

  for (let attempt = 0; attempt < ADMIN_GROQ_KEYS.length; attempt++) {
    const keyIdx = (startIdx + attempt) % ADMIN_GROQ_KEYS.length;
    try {
      const groq = new Groq.Groq({ apiKey: ADMIN_GROQ_KEYS[keyIdx] });
      const completion = await groq.chat.completions.create({
        model: ADMIN_AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userContent  },
        ],
        stream:      false,
        max_completion_tokens: maxTokens,
        temperature: 0.4,
        top_p:       0.9,
      });
      _adminKeyIdx = keyIdx;
      let text = completion.choices?.[0]?.message?.content || '';
      // Strip <think> blocks
      text = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*/,'').trim();
      return text;
    } catch (err) {
      lastError = err;
      if (isKeyError(err) && attempt < ADMIN_GROQ_KEYS.length - 1) {
        const nextIdx = (keyIdx + 1) % ADMIN_GROQ_KEYS.length;
        console.warn(`[Admin AI Failover] Key #${keyIdx + 1} lỗi (${err.status || err.message}), thử Key #${nextIdx + 1}...`);
        _adminKeyIdx = nextIdx;
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

// Streaming với failover tự động
async function createAdminGroqStreamWithFailover(params) {
  let lastError = null;
  const startIdx = _adminKeyIdx;

  for (let attempt = 0; attempt < ADMIN_GROQ_KEYS.length; attempt++) {
    const keyIdx = (startIdx + attempt) % ADMIN_GROQ_KEYS.length;
    try {
      const groq = new Groq.Groq({ apiKey: ADMIN_GROQ_KEYS[keyIdx] });
      const stream = await groq.chat.completions.create(params);
      _adminKeyIdx = keyIdx;
      return stream;
    } catch (err) {
      lastError = err;
      if (isKeyError(err) && attempt < ADMIN_GROQ_KEYS.length - 1) {
        const nextIdx = (keyIdx + 1) % ADMIN_GROQ_KEYS.length;
        console.warn(`[Admin AI Failover] Key #${keyIdx + 1} lỗi (${err.status || err.message}), thử Key #${nextIdx + 1}...`);
        _adminKeyIdx = nextIdx;
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

// ── Bước 1: Tóm tắt từng cuộc hội thoại ─────────────
// Được gọi 1 lần khi mở modal phân tích.
// Backend lấy toàn bộ tin nhắn → tóm tắt song song → trả về mảng tóm tắt.
router.get('/prepare-analysis/:userId', async (req, res) => {
  try {
    const User = SchoolUserModel;
    const student = await User.findById(req.params.userId);
    if (!student) return res.status(404).json({ error: 'Không tìm thấy học sinh' });

    const grade = gradeFromClass(student.className);
    const { Conversation, Message } = await getChatDB(grade);

    const convs = await Conversation.find({ userId: req.params.userId });

    if (!convs.length) {
      return res.json({ student, summaries: [], totalConvs: 0, totalMsgs: 0 });
    }

    // Lấy messages song song cho tất cả conversations
    const convMessages = await Promise.all(
      convs.map(c => Message.find({ conversationId: c._id }))
    );

    const totalMsgs = convMessages.reduce((sum, msgs) => sum + msgs.length, 0);

    // Tóm tắt từng cuộc hội thoại song song (giới hạn 500 ký tự/tin nhắn trước khi gửi)
    const SUMMARIZE_SYSTEM = `Tóm tắt hội thoại học sinh trong 2-3 câu: chủ đề, mức hiểu bài, thái độ. Tiếng Việt, không bullet.`;

    const summaries = await Promise.all(
      convs.map(async (conv, i) => {
        const msgs = convMessages[i];
        if (!msgs.length) return { title: conv.title, summary: '(Hội thoại trống)', msgCount: 0 };

        // Ghép nội dung, cắt mỗi tin tối đa 400 ký tự để tiết kiệm token
        const transcript = msgs.map(m => {
          const role   = m.role === 'user' ? 'Học sinh' : 'AI';
          const content = (m.content || '').slice(0, 400);
          return `${role}: ${content}`;
        }).join('\n');

        const summary = await callAI(SUMMARIZE_SYSTEM, `Tiêu đề: "${conv.title}"\n\n${transcript}`, 300);
        return { title: conv.title, summary, msgCount: msgs.length };
      })
    );

    res.json({ student, summaries, totalConvs: convs.length, totalMsgs });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi chuẩn bị phân tích: ' + err.message });
  }
});

// ── Bước 2: Chat với AI về học sinh ──────────────────
// Frontend gửi: { summaries, student, messages (lịch sử chat giáo viên-AI) }
// Backend xây system prompt từ tóm tắt đã có → gửi lên AI → trả reply.
router.post('/ai-analyze', async (req, res) => {
  try {
    const { student, summaries, messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Thiếu dữ liệu messages' });
    }

    // Xây system prompt từ tóm tắt (nhỏ gọn, không gửi raw messages)
    let system = `Trợ lý phân tích học sinh cho giáo viên. Tiếng Việt, ngắn gọn, có cấu trúc.\n\n`;
    system += `THÔNG TIN HỌC SINH:\n`;
    system += `- Họ tên: ${student.fullName}\n`;
    system += `- Lớp: ${student.className || '—'}\n`;
    system += `- Giới tính: ${student.gender || '—'}\n`;
    system += `- Ngày sinh: ${student.dob || '—'}\n\n`;

    if (summaries && summaries.length) {
      system += `TÓM TẮT ${summaries.length} CUỘC HỘI THOẠI VỚI AI:\n\n`;
      summaries.forEach((s, i) => {
        system += `[${i + 1}] "${s.title}" (${s.msgCount} tin nhắn)\n${s.summary}\n\n`;
      });
    } else {
      system += `Học sinh chưa có hội thoại nào với AI.\n\n`;
    }

    system += `Dựa vào tóm tắt trên, trả lời câu hỏi giáo viên: mức hiểu bài, điểm mạnh/yếu, khó khăn, gợi ý.`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    const stream = await createAdminGroqStreamWithFailover({
      model:       ADMIN_AI_MODEL,
      messages:    [{ role: 'system', content: system }, ...messages],
      stream:      true,
      max_completion_tokens: 1200,
      temperature: 0.7,
      top_p:       0.9,
    });

    let buf = '';
    let inThink = false;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (!delta) continue;

      buf += delta;

      // Phát hiện và bỏ qua toàn bộ <think>...</think>
      let out = '';
      while (buf.length) {
        if (inThink) {
          const end = buf.indexOf('</think>');
          if (end === -1) { buf = ''; break; } // chưa đến </think>, bỏ hết
          buf = buf.slice(end + 8); // bỏ qua </think>
          inThink = false;
        } else {
          const start = buf.indexOf('<think>');
          if (start === -1) { out += buf; buf = ''; break; }
          out += buf.slice(0, start); // phần trước <think> → gửi
          buf = buf.slice(start + 7);
          inThink = true;
        }
      }

      if (out) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out } }] })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[Admin Analyze Error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Lỗi server: ' + err.message });
    else res.end();
  }
});

// ── Quản lý tài khoản ─────────────────────────────────

// Tài khoản NGOÀI: Teacher + Student từ Supabase (đăng ký email)
router.get('/accounts/outside', async (_req, res) => {
  try {
    const allEmail = await EmailUserModel.find({});
    const teachers = allEmail.filter(u => u.role === 'teacher');
    const students = allEmail.filter(u => u.role === 'student');

    res.json({
      teachers: teachers.map(t => ({
        _id: t.id, fullName: t.fullName, email: t.email,
        subject: t.subject || '', school: t.school || '',
        isVerified: t.isVerified || false,
        createdAt: t.createdAt, role: 'teacher',
      })),
      students: students.map(s => ({
        _id: s.id, fullName: s.fullName, email: s.email,
        gender: s.gender || '', dob: s.dob || '',
        createdAt: s.createdAt, role: 'student',
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tài khoản TRONG: disabled — trả về mảng rỗng để không hiển thị trong UI
router.get('/accounts/inside', async (_req, res) => {
  res.json({ teachers: [], students: [] });
});

// ── Góp ý (admin) ─────────────────────────────────────
const { FeedbackModel } = require('../db');

router.get('/feedback', async (_req, res) => {
  try {
    const items = await FeedbackModel.find();
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Đánh dấu admin đã xem — hỗ trợ cả mark-all và mark từng ID
router.post('/feedback/mark-read', async (req, res) => {
  try {
    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : 'all';
    await FeedbackModel.markAdminRead(ids);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/feedback/:id/reply', async (req, res) => {
  try {
    const { reply } = req.body;
    if (!reply || !reply.trim()) return res.status(400).json({ error: 'Nội dung phản hồi trống' });
    await FeedbackModel.reply(req.params.id, reply.trim());
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/feedback/:id', async (req, res) => {
  try {
    await FeedbackModel.deleteById(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Teacher class assignment ───────────────────────────────────────────────

// GET /api/admin/teachers — list all school (CCCD-based) teachers
router.get('/teachers', async (req, res) => {
  try {
    const docs = await SchoolUserModel.find({ role: 'teacher' }).lean();
    const teachers = docs.map(t => ({
      _id:             String(t.id || t._id),
      fullName:        t.fullName || '',
      cccd:            t.cccd    || '',
      className:       t.className || '',
      assignedClasses: t.assignedClasses || [],
    }));
    res.json({ teachers });
  } catch (err) {
    console.error('[admin/teachers GET]', err.message);
    res.status(500).json({ error: 'Không thể tải danh sách giáo viên' });
  }
});

// PATCH /api/admin/teachers/:id/classes — update assignedClasses for school teacher
router.patch('/teachers/:id/classes', async (req, res) => {
  try {
    const { id } = req.params;
    const { classes } = req.body;

    if (!Array.isArray(classes)) {
      return res.status(400).json({ error: 'classes phải là mảng' });
    }

    const CLASS_RE = /^\d+[A-Za-z]+\d+$/;
    const invalid = classes.find(c => typeof c !== 'string' || !CLASS_RE.test(c));
    if (invalid !== undefined) {
      return res.status(400).json({ error: `Tên lớp không hợp lệ: "${invalid}"` });
    }

    const teacher = await SchoolUserModel.findById(id);
    if (!teacher) return res.status(404).json({ error: 'Không tìm thấy giáo viên' });

    teacher.assignedClasses = [...new Set(classes)];
    await teacher.save();

    res.json({
      ok: true,
      teacher: {
        _id:             String(teacher.id || teacher._id),
        fullName:        teacher.fullName,
        assignedClasses: teacher.assignedClasses,
      },
    });
  } catch (err) {
    console.error('[admin/teachers PATCH]', err.message);
    res.status(500).json({ error: 'Không thể cập nhật phân công lớp' });
  }
});

module.exports = router;
