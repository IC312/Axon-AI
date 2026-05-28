const jwt = require('jsonwebtoken');

function getToken(req) {
  // Ưu tiên httpOnly cookie, fallback về Authorization header
  if (req.cookies && req.cookies.hc_token) return req.cookies.hc_token;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.split(' ')[1];
  return null;
}

function authMiddleware(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại' });
  }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin')
      return res.status(403).json({ error: 'Không có quyền truy cập' });
    next();
  });
}

module.exports = { authMiddleware, adminMiddleware };
