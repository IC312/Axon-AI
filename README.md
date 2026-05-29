# Axon AI

Hệ thống chat AI học tập dành cho học sinh và giáo viên, kết hợp diễn đàn và bảng quản trị.
Backend chạy bằng Express, lưu dữ liệu chat trên Astra DB, lưu tài khoản người dùng trên Supabase (PostgreSQL).

## Tính năng chính

- Đăng nhập học sinh bằng CCCD (tài khoản do trường cấp).
- Đăng ký / đăng nhập học sinh và giáo viên bằng email (OTP xác minh).
- Chat AI theo hội thoại, có rate limit và kiểm duyệt nội dung tự động.
- Forum: bài viết, bình luận, vote, ghim bài, auto scan nội dung.
- Bảng admin: thống kê, danh sách lớp, học sinh, hội thoại, reset mật khẩu, quản lý thông báo.
- Bảng giáo viên: xem học sinh theo lớp phụ trách, gửi thông báo.
- Gửi email OTP xác minh và đặt lại mật khẩu qua Gmail.
- Có thể deploy lên Vercel (serverless).

## Công nghệ

- Node.js + Express
- Astra DB (DataStax — Document API, lưu chat/feedback/announcement)
- Supabase (PostgreSQL — lưu tài khoản school_users, email_users)
- JWT + cookie-based auth
- Groq API (chat AI và moderation)
- Nodemailer + Gmail SMTP (gửi email OTP)

## Yêu cầu

- Node.js 18+ (khuyên dùng Node.js 20)
- npm
- Astra DB account + token
- Supabase project + service role key
- Groq API key
- Gmail account + App Password (để gửi email OTP)

## Cài đặt nhanh

1. Cài dependency:

```bash
npm install
```

2. Tạo file `.env` và điền các biến (xem mục **Biến môi trường** bên dưới).

3. Chạy migration schema lên Supabase (xem `scripts/supabase-schema.sql`).

4. Tạo tài khoản admin mặc định:

```bash
node scripts/create-admin.js
```

5. (Tuỳ chọn) Seed học sinh từ Excel (`scripts/ds_hoc_sinh.xlsx`):

```bash
npm run seed
```

6. (Tuỳ chọn) Seed giáo viên từ Excel (`scripts/Danh_Sach_Tai_Khoan_CCCD.xlsx`):

```bash
node scripts/seed-teachers.js
```

7. Chạy server local:

```bash
npm start
```

Server mặc định chạy tại `http://localhost:3000`.

## Biến môi trường

Tạo file `.env` ở thư mục gốc với nội dung sau:

```env
# Astra DB
ASTRA_TOKEN=AstraCS:xxxx
ASTRA_ENDPOINT=https://xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-us-east1.apps.astra.datastax.com
ASTRA_KEYSPACE=default_keyspace

# Supabase
SUPABASE_URL=https://xxxxxxxxxxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxxx

# JWT
JWT_SECRET=change_this_to_a_long_random_string_at_least_32_chars

# Groq chat (có thể cấu hình nhiều key để failover)
GROQ_API_KEY=gsk_xxx
GROQ_API_KEY_2=
GROQ_API_KEY_3=
GROQ_API_KEY_4=
GROQ_API_KEY_5=

# Groq moderation
GROQ_MOD_KEY_1=gsk_xxx
GROQ_MOD_KEY_2=

# Gmail SMTP (gửi email OTP)
GMAIL_USER=your_email@gmail.com
GMAIL_APP_PASSWORD=xxxx_xxxx_xxxx_xxxx

# Server
PORT=3000
NODE_ENV=development
```

**Lưu ý:** không commit file `.env` lên GitHub.

## Scripts

- `npm start` — chạy server production mode.
- `npm run dev` — chạy server với nodemon (hot reload).
- `npm run seed` — seed học sinh từ Excel.
- `node scripts/seed-teachers.js` — seed giáo viên từ Excel.
- `node scripts/create-admin.js` — tạo tài khoản admin mặc định.
- `node scripts/migrate-to-supabase.js` — migrate dữ liệu cũ sang Supabase.

## Một số route giao diện

| Route | Mô tả |
|---|---|
| `/` | Trang landing |
| `/choose` | Chọn phương thức đăng nhập |
| `/login` | Đăng nhập học sinh (email) |
| `/register` | Đăng ký học sinh bằng email |
| `/teacher` | Đăng ký giáo viên bằng email |
| `/portal` | Đăng nhập học sinh bằng CCCD (URL ẩn) |
| `/portal-teacher` | Đăng nhập giáo viên bằng CCCD (URL ẩn) |
| `/dashboard` | Bảng điều khiển giáo viên |
| `/forum` | Diễn đàn học tập |
| `/admin` | Trang đăng nhập admin (URL ẩn) |
| `/reset-password` | Đặt lại mật khẩu |

## Cấu trúc dữ liệu

### Astra DB (chat & nội dung)

- `conversations_6` … `conversations_9` — hội thoại theo khối lớp.
- `messages_6` … `messages_9` — tin nhắn theo hội thoại.
- `feedback` — góp ý ẩn danh + thông báo (phân biệt bằng field `type`).
- `forum_posts`, `forum_comments` — dữ liệu diễn đàn.

### Supabase (tài khoản người dùng)

- `school_users` — tài khoản do trường cấp (CCCD / username, bcrypt + JWT).
- `email_users` — tài khoản tự đăng ký bằng email (học sinh + giáo viên).

## Bảo mật

- Không commit secrets (token, API key, password).
- Đổi mật khẩu admin mặc định ngay sau khi tạo.
- `SUPABASE_SERVICE_KEY` chỉ dùng ở server — tuyệt đối không expose ra client/browser.
- Dùng `NODE_ENV=production` khi deploy.
