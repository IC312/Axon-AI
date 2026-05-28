# Hermes Chat (Astra DB + MongoDB)

Hệ thống chat học sinh, quản trị viên và forum học tập.
Backend chạy bằng Express, lưu dữ liệu chính trên Astra DB Document API, bổ sung MongoDB cho một số luồng đăng ký/đăng nhập.

## Tính năng chính

- Đăng nhập học sinh bằng CCCD.
- Đăng ký/đăng nhập học sinh bằng email.
- Đăng ký/đăng nhập giáo viên.
- Chat AI theo hội thoại, có rate limit và moderation.
- Forum có bài viết, bình luận, vote, ghim bài, auto scan nội dung.
- Admin dashboard: xem thống kê, danh sách lớp, học sinh, hội thoại, reset mật khẩu.

## Công nghệ

- Node.js + Express
- Astra DB (Document API)
- MongoDB (Mongoose)
- JWT + cookie-based auth
- Groq API (chat và moderation)

## Yêu cầu

- Node.js 18+ (khuyên dùng Node.js 20)
- npm
- Astra DB account + token
- MongoDB connection string (nếu dùng luồng email/teacher)
- Groq API key

## Cài đặt nhanh

1. Cài dependency:

```bash
npm install
```

2. Tạo file môi trường:

```bash
cp .env.example .env
```

3. Điền đầy đủ biến trong `.env`.

4. Tạo admin mặc định:

```bash
node scripts/create-admin.js
```

5. Seed học sinh từ Excel (file `scripts/ds_hoc_sinh.xlsx`):

```bash
node scripts/seed-students.js
```

6. Chạy server local:

```bash
npm start
```

Server mặc định chạy tại `http://localhost:3000`.

## Biến môi trường

Dựa theo `.env.example`:

```env
# Astra DB
ASTRA_DB_APPLICATION_TOKEN=AstraCS:xxxx
ASTRA_DB_API_ENDPOINT=https://xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-us-east1.apps.astra.datastax.com
ASTRA_DB_NAMESPACE=default_keyspace

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

# Server
PORT=3000
NODE_ENV=development
```

Luu y: khong commit file `.env` len GitHub.

## Scripts

- `npm start`: chạy server production mode.
- `npm run dev`: chạy server với nodemon.
- `npm run seed`: seed học sinh từ Excel.

## Một số route giao diện

- `/` -> landing
- `/login` -> đăng nhập học sinh
- `/register` -> đăng ký học sinh email
- `/teacher` -> đăng ký giáo viên
- `/forum` -> forum
- `/admin` -> đăng nhập admin
- `/portal` -> cổng CCCD học sinh
- `/portal-teacher` -> cổng CCCD giáo viên

## Cấu trúc dữ liệu (tổng quan)

- `users`: tài khoản học sinh/admin.
- `conversations_6..9`: hội thoại theo khối lớp.
- `messages_6..9`: tin nhắn theo hội thoại.
- `forum_posts`, `forum_comments`: dữ liệu diễn đàn.

## Cập nhật GitHub (ghi đè toàn bộ theo bản local)

Neu ban muon moi lan cap nhat deu "xoa sach ban cu tren GitHub va ghi de bang ban local", dung quy trinh sau:

```bash
git add -A
git commit -m "update"
git push origin main --force-with-lease
```

`--force-with-lease` an toan hon `--force` vi no se chan ghi de neu remote vua co commit moi ma ban chua keo ve.

## Bao mat

- Không commit secrets (token, API key, password).
- Đổi mật khẩu admin mặc định ngay sau khi tạo.
- Dùng `NODE_ENV=production` khi deploy.
