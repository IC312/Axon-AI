require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const cookieParser = require('cookie-parser');
const helmet  = require('helmet');

const app = express();

// ── CORS ──────────────────────────────────────────────
// Trên Vercel, origin là domain của chính app → cho phép tất cả cùng origin
app.use(cors({ origin: true, credentials: true }));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      fontSrc:       ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc:        ["'self'", "data:"],
      connectSrc:    ["'self'"],
      frameAncestors:["'none'"],
      objectSrc:     ["'none'"],
      baseUri:       ["'self'"],
      formAction:    ["'self'"],
    },
  },
}));
app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ── Chặn truy cập trực tiếp vào các file nhạy cảm ─────
// Dù ai đoán được tên file cũng bị chặn, chỉ server route mới phục vụ được
const BLOCKED_FILES = ['/_school.html', '/_school-teacher.html', '/admin-login.html'];
app.use((req, res, next) => {
  if (BLOCKED_FILES.includes(req.path)) return res.redirect(301, '/');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ────────────────────────────────────────
app.use('/api/auth',  require('./routes/auth'));
app.use('/api/chat',  require('./routes/chat'));
app.use('/api/public-demo', require('./routes/public-demo'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/admin/excel',  require('./routes/excel'));
app.use('/api/teacher',       require('./routes/teacher'));
app.use('/api/announcements', require('./routes/announcements'));
const { router: forumRouter, startAutoScan } = require('./routes/forum');
app.use('/api/forum', forumRouter);

// ── Admin login — URL ẩn /admin ───────────────────────
app.get('/admin', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'))
);

// ── Teacher dashboard ─────────────────────────────────
app.get('/dashboard', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'teacher.html'))
);

// ── Forum page ─────────────────────────────────────────
app.get('/forum', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'forum.html'))
);

// ── Login chooser ─────────────────────────────────────
app.get('/choose', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'choose-login.html'))
);

// ── CCCD school login — URL ẩn /portal ────────────────
app.get('/portal', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', '_school.html'))
);

// ── CCCD teacher login — URL ẩn /portal-teacher ───────
app.get('/portal-teacher', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', '_school-teacher.html'))
);

// ── Clean URL aliases ─────────────────────────────────
app.get('/login',           (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register',        (_req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/teacher',         (_req, res) => res.sendFile(path.join(__dirname, 'public', 'register-teacher.html')));
app.get('/reset-password',  (_req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));

// ── Fallback → Landing ────────────────────────────────
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'landing.html'))
);

// ── Global error handler ──────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Unhandled]', err.message);
  res.status(err.status || 500).json({ error: 'Lỗi máy chủ' });
});

// ── Local dev server ──────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀  Server running → http://localhost:${PORT}`);
    require('./cleanup').startCleanup();
    startAutoScan();
  });
}

module.exports = app;
