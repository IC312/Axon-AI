const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { getConnection } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { SchoolUserModel, EmailUserModel } = require('../db-supabase');
const {
  sendVerificationEmail,
  sendResetPasswordEmail,
  sendRecoveryOtpEmail,
} = require('../utils/email');

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

/** Tạo mã OTP ngẫu nhiên 6 chữ số */
function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Thời điểm hết hạn OTP (mặc định 10 phút) */
function otpExpiry(minutes = 10) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

function makeToken(user, grade) {
  return jwt.sign(
    { id: user._id || user.id, role: user.role, grade },
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

// ── Đăng nhập (CCCD — tài khoản trường) ──────────────
router.post('/login', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    if (!checkLoginRateLimit(ip))
      return res.status(429).json({ error: 'Quá nhiều lần thử. Vui lòng đợi 1 phút.' });

    const cccd    = String(req.body.cccd    ?? '').trim();
    const password = String(req.body.password ?? '');
    if (!cccd || !password)
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });

    const user = await SchoolUserModel.findOne({
      $or: [{ cccd }, { username: cccd }],
    });
    const passwordMatch = user && await bcrypt.compare(password, user.password_hash);
    if (!user || !passwordMatch)
      return res.status(401).json({ error: 'Số CCCD hoặc mật khẩu không đúng' });

    const grade = gradeFromClass(user.class_name);
    const token = makeToken(user, grade);

    res.cookie('hc_token', token, COOKIE_OPTS);
    res.json({
      role:               user.role,
      fullName:           user.full_name,
      className:          user.class_name || '',
      gender:             user.gender     || '',
      dob:                user.dob        || '',
      mustChangePassword: user.must_change_password || false,
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

    const existing = await EmailUserModel.findByEmail(email);
    if (existing)
      return res.status(409).json({ error: 'Email này đã được đăng ký' });

    const passwordHash = await bcrypt.hash(password, 10);
    const otpCode = generateOtp();
    const user = await EmailUserModel.create({
      fullName,
      email,
      passwordHash,
      role:            'student',
      emailVerified:   false,
      verificationOtp: otpCode,
      otpExpiresAt:    otpExpiry(5),
    });

    await sendVerificationEmail(email, user.id, otpCode).catch(e =>
      console.error('[Register] Gửi OTP thất bại:', e.message)
    );

    return res.status(201).json({ requiresVerification: true, email });
  } catch (err) { console.error('[Register]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// ── Xác minh OTP email ────────────────────────────────
router.post('/verify-email', async (req, res) => {
  try {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const otp   = String(req.body.otp   ?? '').trim();

    if (!email || !otp)
      return res.status(400).json({ error: 'Vui lòng nhập email và mã OTP.' });
    if (!/^\d{6}$/.test(otp))
      return res.status(400).json({ error: 'Mã OTP không hợp lệ.' });

    const user = await EmailUserModel.findByEmail(email);
    if (!user)
      return res.status(404).json({ error: 'Tài khoản không tồn tại.' });
    if (user.emailVerified)
      return res.status(400).json({ error: 'Tài khoản này đã được xác minh.' });
    if (!user.verificationOtp || user.verificationOtp !== otp)
      return res.status(400).json({ error: 'Mã OTP không đúng.' });
    if (!user.otpExpiresAt || new Date(user.otpExpiresAt) < new Date())
      return res.status(400).json({ error: 'Mã OTP đã hết hạn. Vui lòng yêu cầu mã mới.' });

    user.emailVerified   = true;
    user.verificationOtp = null;
    user.otpExpiresAt    = null;
    await user.save();

    const token = makeToken(user, 9);
    res.cookie('hc_token', token, COOKIE_OPTS);
    res.json({ role: user.role, fullName: user.fullName, authType: 'email' });
  } catch (err) { console.error('[VerifyEmail]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// ── Gửi lại mã OTP xác minh ──────────────────────────
router.post('/resend-verification', async (req, res) => {
  try {
    const ip    = req.ip || req.socket.remoteAddress;
    const email = String(req.body.email ?? '').trim().toLowerCase();

    if (!email)
      return res.status(400).json({ error: 'Vui lòng nhập email.' });
    if (!checkLoginRateLimit(ip))
      return res.status(429).json({ error: 'Quá nhiều yêu cầu. Vui lòng đợi 1 phút.' });

    const user = await EmailUserModel.findByEmail(email);

    // Trả 200 dù user không tồn tại để tránh email enumeration
    if (!user || user.emailVerified)
      return res.json({ ok: true });

    // Giới hạn: chỉ cho gửi lại sau 60 giây
    if (user.otpExpiresAt) {
      const issuedAt = new Date(user.otpExpiresAt).getTime() - 5 * 60 * 1000;
      if (Date.now() - issuedAt < 60 * 1000)
        return res.status(429).json({ error: 'Vui lòng đợi 60 giây trước khi gửi lại.' });
    }

    const otpCode = generateOtp();
    user.verificationOtp = otpCode;
    user.otpExpiresAt    = otpExpiry(5);
    await user.save();

    const { error: mailErr } = await sendVerificationEmail(email, user.id, otpCode).then(() => ({})).catch(e => ({ error: e }));
    if (mailErr) {
      console.error('[ResendVerification] Gửi OTP thất bại:', mailErr.message);
      return res.status(500).json({ error: 'Không thể gửi email. Vui lòng thử lại.' });
    }

    res.json({ ok: true });
  } catch (err) { console.error('[ResendVerification]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// ── Đăng nhập bằng Email (học sinh ngoài) ─────────────
router.post('/login-email', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    if (!checkLoginRateLimit(ip))
      return res.status(429).json({ error: 'Quá nhiều lần thử. Vui lòng đợi 1 phút.' });

    const email    = String(req.body.email    ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');

    if (!email || !password)
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });

    const user = await EmailUserModel.findByEmail(email);
    const passwordMatch = user && await bcrypt.compare(password, user.passwordHash);
    if (!user || !passwordMatch)
      return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });

    if (!user.emailVerified)
      return res.status(403).json({ requiresVerification: true, error: 'Vui lòng xác minh email trước khi đăng nhập.' });

    const token = makeToken(user, user.grade || 9);
    res.cookie('hc_token', token, COOKIE_OPTS);
    res.json({ role: user.role, fullName: user.fullName, authType: 'email' });
  } catch (err) { console.error('[LoginEmail]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// ── Đăng ký tài khoản Giáo viên ngoài ────────────────
router.post('/register-teacher', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    if (!checkLoginRateLimit(ip))
      return res.status(429).json({ error: 'Quá nhiều lần thử. Vui lòng đợi 1 phút.' });

    const fullName = normalizeFullName(req.body.fullName);
    const email    = String(req.body.email   ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');
    const subject  = String(req.body.subject  ?? '').trim().slice(0, 100);
    const school   = String(req.body.school   ?? '').trim().slice(0, 200);

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

    const existing = await EmailUserModel.findByEmail(email);
    if (existing)
      return res.status(409).json({ error: 'Email này đã được đăng ký' });

    const passwordHash = await bcrypt.hash(password, 10);
    // Giáo viên ngoài: cần xác minh email như học sinh ngoài
    const otpCode = generateOtp();
    const teacher = await EmailUserModel.create({
      fullName,
      email,
      passwordHash,
      role:            'teacher',
      subject,
      schoolName:      school,
      emailVerified:   false,
      verificationOtp: otpCode,
      otpExpiresAt:    otpExpiry(5),
    });

    await sendVerificationEmail(email, teacher.id, otpCode).catch(e =>
      console.error('[RegisterTeacher] Gửi OTP thất bại:', e.message)
    );

    return res.status(201).json({ requiresVerification: true, email });
  } catch (err) { console.error('[RegisterTeacher]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// ── Đăng nhập Giáo viên ngoài ─────────────────────────
router.post('/login-teacher', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress;
    if (!checkLoginRateLimit(ip))
      return res.status(429).json({ error: 'Quá nhiều lần thử. Vui lòng đợi 1 phút.' });

    const email    = String(req.body.email    ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');

    if (!email || !password)
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });

    const teacher = await EmailUserModel.findOne({ email, role: 'teacher' });
    const passwordMatch = teacher && await bcrypt.compare(password, teacher.passwordHash);
    if (!teacher || !passwordMatch)
      return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });

    if (!teacher.emailVerified)
      return res.status(403).json({ requiresVerification: true, error: 'Vui lòng xác minh email trước khi đăng nhập.' });

    const token = makeToken(teacher, 9);
    res.cookie('hc_token', token, COOKIE_OPTS);
    res.json({ role: teacher.role, fullName: teacher.fullName, authType: 'email' });
  } catch (err) { console.error('[LoginTeacher]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// ── Đổi mật khẩu (email accounts + school accounts) ──
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const currentPassword = String(req.body.currentPassword ?? '');
    const newPassword     = String(req.body.newPassword     ?? '');
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Vui lòng điền đầy đủ' });

    if (newPassword.length < 8)
      return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 8 ký tự' });
    if (!/[a-z]/i.test(newPassword) || !/\d/.test(newPassword))
      return res.status(400).json({ error: 'Mật khẩu phải chứa chữ cái và số' });

    // Tìm trong cả hai bảng
    let user = await EmailUserModel.findById(req.user.id);
    if (!user) user = await SchoolUserModel.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Không tìm thấy người dùng' });

    if (!(await bcrypt.compare(currentPassword, user.passwordHash)))
      return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });

    user.passwordHash       = await bcrypt.hash(newPassword, 10);
    user.mustChangePassword = false;
    await user.save();

    res.json({ ok: true, message: 'Đổi mật khẩu thành công' });
  } catch (err) { console.error('[ChangePassword]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// ── Xóa tài khoản (chỉ tài khoản email ngoài) ─────────
router.delete('/account', authMiddleware, async (req, res) => {
  try {
    const password = String(req.body.password ?? '');
    if (!password)
      return res.status(400).json({ error: 'Vui lòng nhập mật khẩu để xác nhận.' });

    const user = await EmailUserModel.findById(req.user.id);

    // Nếu không tìm thấy trong email_users → là tài khoản trường
    if (!user)
      return res.status(403).json({ error: 'Tài khoản trường không thể tự xóa.' });

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch)
      return res.status(401).json({ error: 'Mật khẩu không đúng.' });

    await user.deleteOne();

    res.clearCookie('hc_token', { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true, message: 'Tài khoản đã được xóa thành công.' });
  } catch (err) { console.error('[DeleteAccount]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// ═══════════════════════════════════════════════════════
// QUÊN / ĐẶT LẠI MẬT KHẨU — tài khoản email ngoài
// ═══════════════════════════════════════════════════════

// POST /api/auth/forgot-password — gửi link reset về email
router.post('/forgot-password', async (req, res) => {
  try {
    const ip    = req.ip || req.socket.remoteAddress;
    const email = String(req.body.email ?? '').trim().toLowerCase();
    if (!email)
      return res.status(400).json({ error: 'Vui lòng nhập email.' });
    if (!checkLoginRateLimit(ip))
      return res.status(429).json({ error: 'Quá nhiều yêu cầu. Vui lòng đợi 1 phút.' });

    const user = await EmailUserModel.findByEmail(email);
    // Trả 200 dù không tìm thấy để tránh email enumeration
    if (!user || !user.emailVerified) {
      return res.json({ ok: true });
    }

    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 giờ
    user.resetToken          = token;
    user.resetTokenExpiresAt = expires;
    await user.save();

    const resetLink = `${process.env.APP_URL || 'https://axonaiedu.vercel.app'}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;
    const emailResult = await sendResetPasswordEmail(email, user.id, resetLink);
    if (!emailResult.success) {
      console.error('[ForgotPassword] sendResetPasswordEmail failed:', emailResult.error);
    }

    res.json({ ok: true });
  } catch (err) { console.error('[ForgotPassword]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// POST /api/auth/reset-password — đặt lại mật khẩu bằng token
router.post('/reset-password', async (req, res) => {
  try {
    const email       = String(req.body.email       ?? '').trim().toLowerCase();
    const token       = String(req.body.token       ?? '').trim();
    const newPassword = String(req.body.newPassword ?? '');

    if (!email || !token || !newPassword)
      return res.status(400).json({ error: 'Thiếu thông tin bắt buộc.' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 8 ký tự' });
    if (!/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/\d/.test(newPassword))
      return res.status(400).json({ error: 'Mật khẩu phải có chữ thường, chữ hoa và số' });

    const user = await EmailUserModel.findByEmail(email);
    if (!user || !user.resetToken || user.resetToken !== token)
      return res.status(400).json({ error: 'Liên kết đặt lại mật khẩu không hợp lệ.' });
    if (!user.resetTokenExpiresAt || new Date(user.resetTokenExpiresAt) < new Date())
      return res.status(400).json({ error: 'Liên kết đặt lại mật khẩu đã hết hạn.' });

    user.passwordHash        = await bcrypt.hash(newPassword, 10);
    user.resetToken          = null;
    user.resetTokenExpiresAt = null;
    await user.save();

    res.json({ ok: true, message: 'Mật khẩu đã được đặt lại thành công.' });
  } catch (err) { console.error('[ResetPassword]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// ═══════════════════════════════════════════════════════
// RECOVERY EMAIL — tài khoản trường (CCCD-based)
// ═══════════════════════════════════════════════════════

// POST /api/auth/school/add-recovery-email (authed) — thêm email phụ + gửi OTP
router.post('/school/add-recovery-email', authMiddleware, async (req, res) => {
  try {
    // Frontend gửi field "recoveryEmail", hỗ trợ cả "email" để linh hoạt
    const email = String(req.body.recoveryEmail ?? req.body.email ?? '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Email không hợp lệ.' });

    const user = await SchoolUserModel.findById(req.user.id);
    if (!user)
      return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });

    const otpCode = generateOtp();
    user.recoveryEmail          = email;
    user.recoveryEmailVerified  = false;
    user.recoveryOtp            = otpCode;
    user.recoveryOtpExpiresAt   = otpExpiry(5);
    await user.save();

    const emailResult = await sendRecoveryOtpEmail(email, user.id, otpCode);
    if (!emailResult.success) {
      console.error('[AddRecoveryEmail] failed:', emailResult.error);
      return res.status(500).json({ error: 'Không thể gửi email. Vui lòng thử lại.' });
    }

    res.json({ ok: true });
  } catch (err) { console.error('[AddRecoveryEmail]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// POST /api/auth/school/verify-recovery-email (authed) — xác minh OTP
router.post('/school/verify-recovery-email', authMiddleware, async (req, res) => {
  try {
    const otp = String(req.body.otp ?? '').trim();
    if (!/^\d{6}$/.test(otp))
      return res.status(400).json({ error: 'Mã OTP không hợp lệ.' });

    const user = await SchoolUserModel.findById(req.user.id);
    if (!user)
      return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    if (!user.recoveryOtp || user.recoveryOtp !== otp)
      return res.status(400).json({ error: 'Mã OTP không đúng.' });
    if (!user.recoveryOtpExpiresAt || new Date(user.recoveryOtpExpiresAt) < new Date())
      return res.status(400).json({ error: 'Mã OTP đã hết hạn.' });

    user.recoveryEmailVerified  = true;
    user.recoveryOtp            = null;
    user.recoveryOtpExpiresAt   = null;
    await user.save();

    res.json({ ok: true, recoveryEmail: user.recoveryEmail });
  } catch (err) { console.error('[VerifyRecoveryEmail]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// POST /api/auth/school/forgot-password — yêu cầu OTP reset bằng CCCD + recovery email
router.post('/school/forgot-password', async (req, res) => {
  try {
    const ip    = req.ip || req.socket.remoteAddress;
    const cccd  = String(req.body.cccd  ?? '').trim();
    const email = String(req.body.email ?? '').trim().toLowerCase();

    if (!cccd || !email)
      return res.status(400).json({ error: 'Vui lòng nhập CCCD và email khôi phục.' });
    if (!checkLoginRateLimit(ip))
      return res.status(429).json({ error: 'Quá nhiều yêu cầu. Vui lòng đợi 1 phút.' });

    const user = await SchoolUserModel.findOne({
      $or: [{ cccd }, { username: cccd }],
    });
    // Không tiết lộ user có tồn tại hay không, nhưng kiểm tra recovery email khớp
    if (!user || !user.recoveryEmailVerified || user.recoveryEmail !== email)
      return res.json({ ok: true });

    const otpCode = generateOtp();
    user.recoveryOtp          = otpCode;
    user.recoveryOtpExpiresAt = otpExpiry(5);
    await user.save();

    const emailResult = await sendRecoveryOtpEmail(email, user.id, otpCode);
    if (!emailResult.success) {
      console.error('[SchoolForgotPassword] failed:', emailResult.error);
    }

    res.json({ ok: true });
  } catch (err) { console.error('[SchoolForgotPassword]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

// POST /api/auth/school/reset-password — đặt lại mật khẩu bằng CCCD + OTP
router.post('/school/reset-password', async (req, res) => {
  try {
    const cccd        = String(req.body.cccd        ?? '').trim();
    const email       = String(req.body.email       ?? '').trim().toLowerCase();
    const otp         = String(req.body.otp         ?? '').trim();
    const newPassword = String(req.body.newPassword ?? '');

    if (!cccd || !email || !otp || !newPassword)
      return res.status(400).json({ error: 'Thiếu thông tin bắt buộc.' });
    if (!/^\d{6}$/.test(otp))
      return res.status(400).json({ error: 'Mã OTP không hợp lệ.' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 8 ký tự' });
    if (!/[a-z]/i.test(newPassword) || !/\d/.test(newPassword))
      return res.status(400).json({ error: 'Mật khẩu phải chứa chữ cái và số' });

    const user = await SchoolUserModel.findOne({
      $or: [{ cccd }, { username: cccd }],
    });
    if (!user || !user.recoveryEmailVerified || user.recoveryEmail !== email)
      return res.status(400).json({ error: 'Thông tin không hợp lệ.' });
    if (!user.recoveryOtp || user.recoveryOtp !== otp)
      return res.status(400).json({ error: 'Mã OTP không đúng.' });
    if (!user.recoveryOtpExpiresAt || new Date(user.recoveryOtpExpiresAt) < new Date())
      return res.status(400).json({ error: 'Mã OTP đã hết hạn.' });

    user.passwordHash         = await bcrypt.hash(newPassword, 10);
    user.mustChangePassword   = false;
    user.recoveryOtp          = null;
    user.recoveryOtpExpiresAt = null;
    await user.save();

    res.json({ ok: true, message: 'Mật khẩu đã được đặt lại thành công.' });
  } catch (err) { console.error('[SchoolResetPassword]', err.message); res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

module.exports = router;
