'use strict';

const nodemailer = require('nodemailer');

// Lazy-init transporter — chỉ tạo một lần khi hàm gửi đầu tiên được gọi.
let _transporter = null;
function getTransporter() {
  if (!_transporter) {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      throw new Error('GMAIL_USER hoặc GMAIL_APP_PASSWORD chưa được cấu hình.');
    }
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return _transporter;
}

const FROM_ADDRESS = `⚡ Axon AI <${process.env.GMAIL_USER || 'axonaiedu@gmail.com'}>`;

// ─── Template: OTP Verification ───────────────────────────────────────────────
function buildVerificationHtml(otpCode) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Xác minh tài khoản</title>
</head>
<body style="margin:0;padding:0;background-color:#0d0d0f;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0d0d0f;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0"
               style="max-width:520px;background-color:#18181b;border-radius:16px;
                      border:1px solid #27272a;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);
                       padding:32px 40px;text-align:center;">
              <p style="margin:0;font-size:28px;font-weight:700;
                        color:#ffffff;letter-spacing:-0.5px;">⚡ Axon AI</p>
              <p style="margin:8px 0 0;font-size:14px;color:#e0e7ff;opacity:0.85;">
                Xác minh địa chỉ email của bạn
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;text-align:center;">
              <p style="margin:0 0 8px;font-size:15px;color:#a1a1aa;">
                Chào bạn,
              </p>
              <p style="margin:0 0 28px;font-size:15px;color:#d4d4d8;line-height:1.6;">
                Sử dụng mã OTP bên dưới để xác minh tài khoản. Mã có hiệu lực
                trong <strong style="color:#a78bfa;">5 phút</strong>.
              </p>

              <!-- OTP Box -->
              <div style="background-color:#09090b;border:1px solid #3f3f46;
                          border-radius:12px;padding:28px 16px;text-align:center;
                          margin-bottom:28px;">
                <p style="margin:0 0 8px;font-size:12px;font-weight:600;
                           letter-spacing:2px;color:#71717a;text-transform:uppercase;">
                  Mã xác minh
                </p>
                <p style="margin:0;font-size:48px;font-weight:800;
                           letter-spacing:14px;color:#a78bfa;
                           font-family:'Courier New',Courier,monospace;">
                  ${otpCode}
                </p>
              </div>

              <p style="margin:0;font-size:13px;color:#52525b;line-height:1.6;">
                Nếu bạn không yêu cầu mã này, hãy bỏ qua email này.
                Tài khoản của bạn vẫn an toàn.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#09090b;padding:20px 40px;
                       border-top:1px solid #27272a;text-align:center;">
              <p style="margin:0;font-size:12px;color:#3f3f46;">
                © 2026 Axon AI · Email tự động, vui lòng không trả lời
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Template: Reset Password ──────────────────────────────────────────────────
function buildResetPasswordHtml(resetLink) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Đặt lại mật khẩu</title>
</head>
<body style="margin:0;padding:0;background-color:#0d0d0f;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0d0d0f;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0"
               style="max-width:520px;background-color:#18181b;border-radius:16px;
                      border:1px solid #27272a;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#ef4444 0%,#f97316 100%);
                       padding:32px 40px;text-align:center;">
              <p style="margin:0;font-size:28px;font-weight:700;
                        color:#ffffff;letter-spacing:-0.5px;">⚡ Axon AI</p>
              <p style="margin:8px 0 0;font-size:14px;color:#fef2f2;opacity:0.85;">
                Yêu cầu đặt lại mật khẩu
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;text-align:center;">
              <p style="margin:0 0 8px;font-size:15px;color:#a1a1aa;">
                Chào bạn,
              </p>
              <p style="margin:0 0 28px;font-size:15px;color:#d4d4d8;line-height:1.6;">
                Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn.
                Nhấn nút bên dưới để tiếp tục. Liên kết có hiệu lực trong
                <strong style="color:#fb923c;">30 phút</strong>.
              </p>

              <!-- CTA Button -->
              <div style="text-align:center;margin:32px 0;">
                <a href="${resetLink}"
                   style="display:inline-block;background:linear-gradient(135deg,#ef4444 0%,#f97316 100%);
                          color:#ffffff;text-decoration:none;font-size:16px;
                          font-weight:700;padding:16px 40px;border-radius:10px;
                          letter-spacing:0.3px;box-shadow:0 4px 24px rgba(239,68,68,0.35);">
                  🔑 Đặt lại mật khẩu
                </a>
              </div>

              <!-- Fallback link -->
              <div style="background-color:#09090b;border:1px solid #3f3f46;
                          border-radius:10px;padding:16px;margin-bottom:24px;text-align:left;">
                <p style="margin:0 0 6px;font-size:12px;color:#71717a;">
                  Nếu nút không hoạt động, sao chép liên kết sau vào trình duyệt:
                </p>
                <p style="margin:0;font-size:12px;color:#a78bfa;
                           word-break:break-all;font-family:'Courier New',Courier,monospace;">
                  ${resetLink}
                </p>
              </div>

              <p style="margin:0;font-size:13px;color:#52525b;line-height:1.6;">
                Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.
                Mật khẩu hiện tại của bạn vẫn không thay đổi.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#09090b;padding:20px 40px;
                       border-top:1px solid #27272a;text-align:center;">
              <p style="margin:0;font-size:12px;color:#3f3f46;">
                © 2026 Axon AI · Email tự động, vui lòng không trả lời
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── sendVerificationEmail ─────────────────────────────────────────────────────
/**
 * Gửi email xác minh tài khoản chứa mã OTP 6 chữ số.
 *
 * @param {string} email   - Địa chỉ email người nhận
 * @param {string} userId  - ID người dùng (chỉ dùng để log)
 * @param {string} otpCode - Mã OTP 6 chữ số
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendVerificationEmail(email, userId, otpCode) {
  if (!email || !userId || !otpCode) {
    return { success: false, error: 'Thiếu tham số bắt buộc.' };
  }

  try {
    const info = await getTransporter().sendMail({
      from: FROM_ADDRESS,
      to: email,
      subject: `[Axon AI] Mã xác minh tài khoản: ${otpCode}`,
      html: buildVerificationHtml(otpCode),
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[email] sendVerificationEmail failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── sendResetPasswordEmail ────────────────────────────────────────────────────
/**
 * Gửi email chứa liên kết đặt lại mật khẩu.
 *
 * @param {string} email      - Địa chỉ email người nhận
 * @param {string} userId     - ID người dùng (chỉ dùng để log)
 * @param {string} resetLink  - URL đặt lại mật khẩu có chứa token
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendResetPasswordEmail(email, userId, resetLink) {
  if (!email || !userId || !resetLink) {
    return { success: false, error: 'Thiếu tham số bắt buộc.' };
  }

  try {
    const info = await getTransporter().sendMail({
      from: FROM_ADDRESS,
      to: email,
      subject: '[Axon AI] Yêu cầu đặt lại mật khẩu',
      html: buildResetPasswordHtml(resetLink),
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[email] sendResetPasswordEmail failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── sendRecoveryOtpEmail ──────────────────────────────────────────────────────
/**
 * Gửi OTP để xác minh email phụ / khôi phục mật khẩu cho tài khoản trường.
 *
 * @param {string} email   - Địa chỉ email người nhận
 * @param {string} userId  - ID người dùng (chỉ dùng để log)
 * @param {string} otpCode - Mã OTP 6 chữ số
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendRecoveryOtpEmail(email, userId, otpCode) {
  if (!email || !userId || !otpCode) {
    return { success: false, error: 'Thiếu tham số bắt buộc.' };
  }

  try {
    const info = await getTransporter().sendMail({
      from: FROM_ADDRESS,
      to: email,
      subject: `[Axon AI] Mã khôi phục mật khẩu: ${otpCode}`,
      html: buildVerificationHtml(otpCode),
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[email] sendRecoveryOtpEmail failed:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendVerificationEmail, sendResetPasswordEmail, sendRecoveryOtpEmail };
