-- ================================================================
-- Axon AI — Supabase Schema
-- Chạy file này trong Supabase Dashboard → SQL Editor
-- ================================================================

-- ── 1. Tài khoản trường (CCCD-based authentication) ──────────────
CREATE TABLE IF NOT EXISTS school_users (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cccd                    TEXT UNIQUE,
  username                TEXT UNIQUE,
  full_name               TEXT NOT NULL,
  password_hash           TEXT NOT NULL,
  role                    TEXT NOT NULL DEFAULT 'student',
  class_name              TEXT NOT NULL DEFAULT '',
  grade                   INTEGER NOT NULL DEFAULT 9,
  gender                  TEXT NOT NULL DEFAULT '',
  dob                     TEXT NOT NULL DEFAULT '',
  must_change_password    BOOLEAN NOT NULL DEFAULT false,
  -- Email phụ để khôi phục mật khẩu (tùy chọn, phải xác minh)
  recovery_email          TEXT,
  recovery_email_verified BOOLEAN NOT NULL DEFAULT false,
  recovery_otp            TEXT,
  recovery_otp_expires_at TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_su_cccd     ON school_users(cccd);
CREATE INDEX IF NOT EXISTS idx_su_username ON school_users(username);
CREATE INDEX IF NOT EXISTS idx_su_role     ON school_users(role);
CREATE INDEX IF NOT EXISTS idx_su_class    ON school_users(class_name);

-- ── 2. Tài khoản email ngoài (học sinh + giáo viên tự đăng ký) ───
CREATE TABLE IF NOT EXISTS email_users (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name               TEXT NOT NULL,
  email                   TEXT UNIQUE NOT NULL,
  password_hash           TEXT NOT NULL,
  role                    TEXT NOT NULL DEFAULT 'student',
  -- Học sinh
  class_name              TEXT NOT NULL DEFAULT '',
  grade                   INTEGER NOT NULL DEFAULT 9,
  gender                  TEXT NOT NULL DEFAULT '',
  dob                     TEXT NOT NULL DEFAULT '',
  -- Giáo viên
  subject                 TEXT NOT NULL DEFAULT '',
  school_name             TEXT NOT NULL DEFAULT '',
  -- Xác minh email
  email_verified          BOOLEAN NOT NULL DEFAULT false,
  verification_otp        TEXT,
  otp_expires_at          TIMESTAMPTZ,
  -- Đặt lại mật khẩu
  reset_token             TEXT,
  reset_token_expires_at  TIMESTAMPTZ,
  must_change_password    BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eu_email ON email_users(email);
CREATE INDEX IF NOT EXISTS idx_eu_role  ON email_users(role);

-- ── 3. Tắt RLS (chúng ta tự quản lý auth bằng bcrypt + JWT) ──────
ALTER TABLE school_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE email_users  DISABLE ROW LEVEL SECURITY;
