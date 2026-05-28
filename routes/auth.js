const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { getConnection, getUserModel } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { connectMongo, Teacher, Student } = require('../db-mongo');

// ── Rate limit đăng nhập: 10 lần/phút mỗi IP ─────────
const loginAttempts = new Map(); // ip → { count, resetAt }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts.entries())
    if (now > v.resetAt) loginAttempts.delete(k);
}, 5 * 60 * 1000);

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 60 * 1000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge:   7 * 24 * 60 * 60 * 1000, // 7 ngày
  secure:   process.env.NODE_ENV === 'production',
};

function gradeFromClass(className) {
  const match = (className || '').match(/^(\d)/);
  return match ? parseInt(match[1]) : 9;
}

function makeToken(user, grade) {
  return jwt.sign(
    { id: user._id, role: user.role, grade },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRY || '1d' } // Mặc định 1 ngày (an toàn hơn 7 ngày)
  );
}

function toTitleCaseWord(word) {
  return word
    .split(/([\-'])/u)
    .map(part => {
      if (!part || part === '-' || part === "'") return part;
      return part.charAt(0).toLocaleUpperCase('vi-VN') + part.slice(1).toLocaleLowerCase('vi-VN');
    })
    .join('');
}

function normalizeFullName(value) {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalized.split(' ').map(toTitleCaseWord).join(' ');
}

function validateHumanFullName(fullName) {
  if (!fullName) return 'Vui lòng nhập họ tên';
  const nameParts = fullName.split(/\s+/).filter(Boolean);
  if (nameParts.length < 2) return 'Họ tên phải có ít nhất 2 từ (ví dụ: Nguyễn Văn A)';
  if (nameParts.some(w => w.length < 2)) return 'Mỗi từ trong họ tên phải có ít nhất 2 ký tự';
  if (fullName.replace(/\s/g, '').length < 6) return 'Họ tên quá ngắn';
  if (!/^[\p{L}\s\-'.]+$/u.test(fullName)) return 'Họ tên không được chứa số hoặc ký tự đặc biệt';
  if (/(.)\1{2,}/u.test(fullName.replace(/\s/g, ''))) return 'Họ tên không hợp lệ (chứa ký tự lặp bất thường)';
  const vowelRe = /[aăâeêioôơuưyàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵAĂÂEÊIOÔƠUƯYÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴ]/;
  if (nameParts.some(w => !vowelRe.test(w))) return 'Họ tên không hợp lệ (mỗi từ phải có nguyên âm)';
  return null;
}

// ── Đăng nhập ─────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    if (!checkLoginRateLimit(ip))
      return res.status(429).json({ error: 'Quá nhiều lần thử. Vui lòng đợi 1 phút.' });

    const cccd    = String(req.body.cccd    ?? '').trim();
    const password = String(req.body.password ?? '');
    if (!cccd || !password)
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });

    const _conn = await getConnection(9);
    const UserModel = getUserModel(_conn);
    const user = await UserModel.findOne({ $or: [{ cccd }, { username: cccd }, { email: cccd }] });
    const passwordMatch = user && await bcrypt.compare(password, user.passwordHash);
    if (!user || !passwordMatch)
      return res.status(401).json({ error: 'Số CCCD hoặc mật khẩu không đúng' });

    const grade = gradeFromClass(user.className);
    const token = makeToken(user, grade);

    res.cookie('hc_token', token, COOKIE_OPTS);
    res.json({
      role:               user.role,
      fullName:           user.fullName,
      className:          user.className || '',
      gender:             user.gender || '',
      dob:                user.dob || '',
      mustChangePassword: user.mustChangePassword || false,
    });
  } catch (err) { console.error('[Login]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// ── Đăng xuất ─────────────────────────────────────────
router.post('/logout', (_req, res) => {
  res.clearCookie('hc_token', { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true });
});

// ── Kiểm tra session hiện tại ─────────────────────────
router.get('/me', authMiddleware, (req, res) => {
  res.json({ role: req.user.role, id: req.user.id, fullName: req.user.fullName });
});

// ── Đăng ký tài khoản email ───────────────────────────
router.post('/register', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    if (!checkLoginRateLimit(ip))
      return res.status(429).json({ error: 'Quá nhiều lần thử. Vui lòng đợi 1 phút.' });

    const fullName = normalizeFullName(req.body.fullName);
    const email    = String(req.body.email    ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');

    if (!fullName || !email || !password)
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
    const fullNameError = validateHumanFullName(fullName);
    if (fullNameError)
      return res.status(400).json({ error: fullNameError });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Email không hợp lệ' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Mật khẩu tối thiểu 8 ký tự' });
    if (!/[a-z]/.test(password))
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 1 chữ thường (a-z)' });
    if (!/[A-Z]/.test(password))
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 1 chữ hoa (A-Z)' });
    if (!/\d/.test(password))
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 1 chữ số (0-9)' });
    if (!/[^A-Za-z0-9]/.test(password))
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 1 ký tự đặc biệt (!@#$…)' });

    await connectMongo();
    const existing = await Student.findOne({ email });
    if (existing)
      return res.status(409).json({ error: 'Email này đã được đăng ký' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await Student.create({
      fullName,
      email,
      passwordHash,
      role:     'student',
      authType: 'email',
    });

    const token = makeToken(user, 9);
    res.cookie('hc_token', token, COOKIE_OPTS);
    res.json({ role: user.role, fullName: user.fullName });
  } catch (err) { console.error('[Register]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});
// ─────────────────────────────────────────────────────

// ── Đăng nhập bằng Email ─────────────────────────────
router.post('/login-email', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    if (!checkLoginRateLimit(ip))
      return res.status(429).json({ error: 'Quá nhiều lần thử. Vui lòng đợi 1 phút.' });

    const email    = String(req.body.email    ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');

    if (!email || !password)
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });

    await connectMongo();
    const user = await Student.findOne({ email });
    const passwordMatch = user && await bcrypt.compare(password, user.passwordHash);
    if (!user || !passwordMatch)
      return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });

    const token = makeToken(user, user.grade || 9);
    res.cookie('hc_token', token, COOKIE_OPTS);
    res.json({ role: user.role, fullName: user.fullName });
  } catch (err) { console.error('[LoginEmail]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});
// ─────────────────────────────────────────────────────

// ── Đăng ký tài khoản Giáo viên (MongoDB) ─────────────
router.post('/register-teacher', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    if (!checkLoginRateLimit(ip))
      return res.status(429).json({ error: 'Quá nhiều lần thử. Vui lòng đợi 1 phút.' });

    const fullName = normalizeFullName(req.body.fullName);
    const email    = String(req.body.email    ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');
    const subject  = String(req.body.subject  ?? '').trim();
    const school   = String(req.body.school   ?? '').trim();

    if (!fullName || !email || !password)
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
    const fullNameError = validateHumanFullName(fullName);
    if (fullNameError)
      return res.status(400).json({ error: fullNameError });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Email không hợp lệ' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Mật khẩu tối thiểu 8 ký tự' });
    if (!/[a-z]/i.test(password) || !/\d/.test(password))
      return res.status(400).json({ error: 'Mật khẩu phải chứa chữ cái và số' });

    await connectMongo();
    const existing = await Teacher.findOne({ email });
    if (existing)
      return res.status(409).json({ error: 'Email này đã được đăng ký' });

    const passwordHash = await bcrypt.hash(password, 10);
    const teacher = await Teacher.create({ fullName, email, passwordHash, subject, school });

    const token = makeToken({ _id: teacher._id, role: teacher.role }, 9);
    res.cookie('hc_token', token, COOKIE_OPTS);
    res.json({ role: teacher.role, fullName: teacher.fullName });
  } catch (err) { console.error('[RegisterTeacher]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// ── Đăng nhập Giáo viên (MongoDB) ─────────────────────
router.post('/login-teacher', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    if (!checkLoginRateLimit(ip))
      return res.status(429).json({ error: 'Quá nhiều lần thử. Vui lòng đợi 1 phút.' });

    const email    = String(req.body.email    ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');

    if (!email || !password)
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });

    await connectMongo();
    const teacher = await Teacher.findOne({ email });
    const passwordMatch = teacher && await bcrypt.compare(password, teacher.passwordHash);
    if (!teacher || !passwordMatch)
      return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });

    const token = makeToken({ _id: teacher._id, role: teacher.role }, 9);
    res.cookie('hc_token', token, COOKIE_OPTS);
    res.json({ role: teacher.role, fullName: teacher.fullName });
  } catch (err) { console.error('[LoginTeacher]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// ── Đổi mật khẩu ──────────────────────────────────────
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Vui lòng điền đầy đủ' });
    
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 8 ký tự' });
    if (!/[a-z]/i.test(newPassword) || !/\d/.test(newPassword))
      return res.status(400).json({ error: 'Mật khẩu phải chứa chữ cái và số' });

    await connectMongo();
    const user = await Student.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
    if (!(await bcrypt.compare(currentPassword, user.passwordHash)))
      return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.mustChangePassword = false;
    await user.save();

    res.json({ ok: true, message: 'Đổi mật khẩu thành công' });
  } catch (err) { console.error('[ChangePassword]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

module.exports = router;
