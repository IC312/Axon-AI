# Copilot Instructions - Hermes Chat (City-Level Competition)

## 1. Project Context

This project is built for a city-level student competition.
Code quality will be reviewed strictly by judges and may also be evaluated by automated AI code-review systems.

You must prioritize:
- correctness
- security
- maintainability
- clear reasoning
- predictable behavior under edge cases

Do not produce "demo-only" code. Every change must be production-minded.

## 2. Current Tech Stack and Architecture

- Runtime: Node.js
- Framework: Express
- Database: Astra DB Data API via @datastax/astra-db-ts
- Auth: JWT + httpOnly cookie
- Password hashing: bcryptjs
- AI integrations: groq-sdk (chat + moderation)
- UI: static HTML files in public folder

Main structure:
- server bootstrap in server.js
- database layer and model-like adapters in db.js
- middleware in middleware/
- route handlers in routes/
- data/admin scripts in scripts/

## 3. Mandatory Rules For Any Code Change

1. Keep business logic consistent with existing architecture.
2. Validate all request input before processing.
3. Return proper HTTP status codes and stable JSON error shape.
4. Never expose secrets, tokens, password hashes, or internal stack traces to clients.
5. Preserve auth boundaries:
   - authMiddleware for authenticated routes
   - adminMiddleware for admin-only routes
6. Keep role and ownership checks explicit for sensitive operations.
7. Avoid breaking existing API contracts unless explicitly requested.
8. Use defensive coding for null/undefined and malformed data.
9. Avoid unnecessary dependencies.
10. Prefer small, readable functions over large monolithic blocks.

## 4. Security and Compliance Requirements

When implementing or editing code, enforce these controls:

- Input sanitization and size limits for user-generated content.
- Strict permission checks on update/delete/admin actions.
- Rate-limiting awareness for login, chat, and expensive endpoints.
- Safe cookie and JWT usage.
- No hardcoded credentials.
- Keep moderation checks for user content paths where required.

If a proposed change weakens security posture, reject it and propose a safer alternative.

## 5. Data and Database Guidelines

- Follow current Astra DB collection patterns and naming conventions.
- Respect existing grade-based partitioning logic for conversations/messages.
- Keep IDs and foreign references type-consistent (string normalization where needed).
- Avoid full-scan behavior unless absolutely required by current DB constraints.
- When scans are unavoidable, enforce safe limits and clear justification.

## 6. API and Error-Handling Standards

For each endpoint:
- Validate required fields early.
- Return 400 for bad input, 401/403 for auth issues, 404 for missing resources, 429 for rate limits, 500 for unexpected server errors.
- Keep messages user-friendly but not revealing internals.
- Ensure async/await blocks handle failures cleanly.

## 7. Performance and Reliability Expectations

- Avoid duplicate DB calls and unnecessary loops.
- Use batching or parallelization only when safe and controlled.
- Protect long-running tasks with limits/timeouts where possible.
- Maintain cleanup behavior for temporary in-memory maps.

## 8. Code Style and Maintainability

- Keep naming explicit and consistent with existing files.
- Add short comments only where logic is non-obvious.
- Do not over-comment trivial statements.
- Keep diffs minimal and focused.
- Do not refactor unrelated parts in the same change.

## 9. Testing and Verification Checklist (Required)

Before finalizing changes, verify:

1. npm start runs without new errors.
2. Auth flow still works:
   - login
   - protected endpoints
   - logout
3. Chat flow still works:
   - create conversation
   - save messages
   - AI endpoint response
4. Forum flow still works:
   - create post/comment
   - delete with permission checks
   - vote updates
5. Admin routes still enforce admin-only access.
6. No regression in moderation behavior.
7. No secrets are logged or returned.

If tests cannot be run, explicitly state what was not verified and why.

## 10. Competition-Oriented Quality Bar

Assume every change will be audited by expert reviewers and AI tools.
Code should be judged as:
- secure by design
- stable under malformed input
- clear to read and defend in oral review
- consistent with existing architecture

When uncertain between quick and robust solutions, choose robust.

## 11. What Copilot Should Avoid

- introducing dead code
- silent catch blocks that hide critical failures
- inconsistent response formats across similar routes
- bypassing middleware for convenience
- weakening validation to make requests "pass"
- changing many files when one file is enough

## 12. Response Behavior For Future Code Tasks

When suggesting or generating code:
- explain key trade-offs briefly
- identify risks and edge cases
- prefer minimal safe patch
- include a concise verification plan

Always align with competition-grade standards, not prototype-grade shortcuts.

---

## 13. OWASP Anti-Pattern Reference (adapted from github/awesome-copilot)

> Source: `security-and-owasp.instructions.md` — https://github.com/github/awesome-copilot

### JWT (AU1-AU3)

```js
// ❌ BAD — không enforce algorithm, dễ bị "alg:none" attack
jwt.verify(token, process.env.JWT_SECRET);

// ✅ GOOD
jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

// ❌ BAD — token không có expiry
jwt.sign(payload, process.env.JWT_SECRET);

// ✅ GOOD
jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1d' });

// ❌ BAD — lưu token trong localStorage (XSS đọc được)
localStorage.setItem('token', token);

// ✅ GOOD — đã làm đúng: httpOnly cookie
res.cookie('hc_token', token, { httpOnly: true, secure: isProd, sameSite: 'lax' });
```

### Express Security Headers (EX1)

```js
// ✅ GOOD — thêm helmet để set đủ security headers (hiện tại thiếu)
const helmet = require('helmet');
app.use(helmet());
app.disable('x-powered-by');
```

### NoSQL Injection — Astra DB (I2)

```js
// ❌ BAD — object từ req.body đi thẳng vào query
await collection.findOne({ username: req.body.username, password: req.body.password });

// ✅ GOOD — ép kiểu String, tách bước hash compare
const username = String(req.body.username ?? '');
const user = await collection.findOne({ username });
const valid = user && await bcrypt.compare(req.body.password, user.passwordHash);
```

### Mass Assignment (AZ4)

```js
// ❌ BAD
await collection.updateOne({ _id: id }, { $set: req.body });

// ✅ GOOD — chỉ lấy field được phép
const { name, email } = req.body;
await collection.updateOne({ _id: id }, { $set: { name, email } });
```

### AI / LLM — Prompt Injection (AI1-AI3)

Dự án dùng GROQ SDK — áp dụng bắt buộc:

```js
// ❌ BAD — nối thẳng user input vào system/prompt
const res = await groq.chat.completions.create({
  messages: [{ role: 'user', content: `Trả lời: ${userInput}` }],
});

// ✅ GOOD — tách rõ system prompt và user message
const res = await groq.chat.completions.create({
  messages: [
    { role: 'system', content: 'Bạn là trợ lý học tập. Chỉ trả lời câu hỏi học thuật.' },
    { role: 'user', content: userInput },
  ],
});

// ✅ Không dùng LLM output làm input cho DB query hoặc shell command
// ✅ Validate schema của LLM response trước khi dùng trong logic
```

### Error Handler — không leak stack trace (EX4 / S6)

```js
// ✅ GOOD — chỉ expose chi tiết lỗi ở môi trường dev
app.use((err, req, res, _next) => {
  const isDev = process.env.NODE_ENV === 'development';
  res.status(500).json({
    error: 'Lỗi máy chủ nội bộ',
    ...(isDev && { message: err.message }),
  });
});
```

---

## 14. Security Checklist — mỗi khi thêm endpoint mới

- [ ] Gắn `authMiddleware` / `adminMiddleware`
- [ ] Kiểm tra ownership của resource (chống IDOR - AZ3)
- [ ] Validate & ép kiểu input phía server
- [ ] Chỉ pick field cần thiết từ `req.body` (chống mass assignment - AZ4)
- [ ] Rate limit nếu là endpoint auth/sensitive (AU5)
- [ ] Cookie có đủ: `httpOnly`, `secure` (prod), `sameSite`
- [ ] JWT verify có `algorithms` option (AU1)
- [ ] Error response không expose stack trace trong production (EX4)
- [ ] Log security event (login fail, access denied, rate limit) — không log password/token (L1/L2)
