# Hermes Chat — Astra DB Edition

## Cấu trúc DB (Astra DB / Cassandra Document API)

| Collection | Mô tả |
|---|---|
| `users` | Tài khoản học sinh + admin |
| `conversations_6` | Hội thoại khối 6 |
| `conversations_7` | Hội thoại khối 7 |
| `conversations_8` | Hội thoại khối 8 |
| `conversations_9` | Hội thoại khối 9 |
| `messages_6..9` | Tin nhắn theo từng khối |

## Setup

1. Copy `.env.example` → `.env` và điền credentials
2. `npm install`
3. `node scripts/create-admin.js` — tạo tài khoản admin
4. `node scripts/seed-students.js` — seed học sinh từ Excel
5. `npm start`

## .env cần có

```
ASTRA_TOKEN=AstraCS:...
ASTRA_ENDPOINT=https://....apps.astra.datastax.com
ASTRA_KEYSPACE=hermes
JWT_SECRET=...
SILICONFLOW_API_KEY=...
PORT=3000
```
