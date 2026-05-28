'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { getCollection, getUserModel, clearCollectionCache } = require('../db');
const { moderateText, keywordBlock, isTitleGibberish } = require('../middleware/moderation');

const now = () => new Date().toISOString();

// ── Rate limit forum: 5 bài/phút, 15 comment/phút mỗi user ──────
const postRateMap    = new Map(); // userId → { count, resetAt }
const commentRateMap = new Map();
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of postRateMap.entries())    if (t > v.resetAt) postRateMap.delete(k);
  for (const [k, v] of commentRateMap.entries()) if (t > v.resetAt) commentRateMap.delete(k);
}, 5 * 60 * 1000);
function checkForumRate(map, userId, max) {
  const now = Date.now();
  const e = map.get(userId);
  if (!e || now > e.resetAt) { map.set(userId, { count: 1, resetAt: now + 60 * 1000 }); return true; }
  if (e.count >= max) return false;
  e.count++; return true;
}

// Tạo collection forum với deny:['*'] để tránh lỗi "100 indexes" của Astra DB.
// Tất cả query đều dùng _id (luôn được index) hoặc filter trong JS.
const NO_INDEX = { indexing: { deny: ['*'] } };
const postsCol = () => getCollection('forum_posts',    NO_INDEX);
const cmtsCol  = () => getCollection('forum_comments', NO_INDEX);
// Không dùng collection riêng cho warnings — lưu trong user document
// để tránh lỗi "100 indexes" của Astra DB (lexical index không thể tắt qua SDK v1.5)

// ── GET /posts?page=1&limit=20&search= ────────────────
router.get('/posts', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const page  = Math.max(parseInt(req.query.page)  || 1,  1);
    const q     = (req.query.search || '').slice(0, 100).toLowerCase().trim();
    const col   = await postsCol();
    // Không dùng sort ở DB vì collection dùng deny:['*'] — sort trong JS bên dưới
    let docs = await col.find({}, { limit: 500 }).toArray();
    docs = docs.filter(d => !d.deleted); // bỏ qua bài đã soft-delete
    if (q) docs = docs.filter(d =>
      (d.title || '').toLowerCase().includes(q) ||
      (d.content || '').toLowerCase().includes(q) ||
      (d.tags || []).some(t => t.toLowerCase().includes(q))
    );
    docs.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    const total = docs.length;
    const uid   = String(req.user.id);
    const items = docs.slice((page - 1) * limit, page * limit).map(d => ({
      ...d, myVote: (d.voters || {})[uid] || 0, voters: undefined,
    }));
    res.json({ posts: items, total, page, limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /posts ───────────────────────────────────────
router.post('/posts', authMiddleware, async (req, res) => {
  try {    if (!checkForumRate(postRateMap, req.user.id, 5))
      return res.status(429).json({ error: 'Bạn đăng bài quá nhiều. Vui lòng đợi 1 phút.' });    const { title, content, tags } = req.body;
    if (!title?.trim())   return res.status(400).json({ error: 'Tiêu đề không được để trống' });
    if (!content?.trim()) return res.status(400).json({ error: 'Nội dung không được để trống' });
    // Chuẩn hóa tags trước khi kiểm duyệt
    const rawTags = Array.isArray(tags)
      ? tags.slice(0, 5).map(t => String(t).trim().slice(0, 30)).filter(Boolean)
      : [];
    // Kiểm duyệt tiêu đề + nội dung + tags
    const tagText = rawTags.join(' ');
    const modCheck = await moderateText(title.trim() + ' ' + content.trim() + (tagText ? ' ' + tagText : ''), title.trim());
    if (!modCheck.allowed) {
      return res.status(422).json({
        error: `Bài viết không phù hợp${modCheck.reason ? ': ' + modCheck.reason : ''}. Vui lòng chỉnh sửa lại.`,
        moderated: true,
      });
    }
    const col = await postsCol();
    const ts  = now();
    const doc = {
      _id:         uuidv4(),
      authorId:    String(req.user.id),
      authorName:  req.user.fullName || 'Ẩn danh',
      authorRole:  req.user.role,
      authorClass: req.user.className || null,
      title:        title.trim().slice(0, 200),
      content:      content.trim().slice(0, 5000),
      tags:         rawTags,
      commentCount: 0,
      upvotes:      0,
      downvotes:    0,
      voters:       {},
      pinned:       false,
      scanned:      true,      // đã qua AI moderation lúc đăng → không cần scan lại
      titleChecked: true,      // đã kiểm tra title-content mismatch lúc đăng
      createdAt:    ts,
      updatedAt:    ts,
    };
    await col.insertOne(doc);
    res.json({ ...doc, voters: undefined, myVote: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /posts/:id ─────────────────────────────────────
router.get('/posts/:id', authMiddleware, async (req, res) => {
  try {
    const postCol = await postsCol();
    const post    = await postCol.findOne({ _id: req.params.id });
    if (!post) return res.status(404).json({ error: 'Không tìm thấy bài viết' });
    const cmtCol  = await cmtsCol();
    // deny:['*']: không thể filter bằng postId ở DB → fetch all rồi filter trong JS
    const allCmts = await cmtCol.find({}, { limit: 5000 }).toArray();
    const cmts    = allCmts
      .filter(c => c.postId === req.params.id && !c.deleted)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const uid = String(req.user.id);
    res.json({
      post:     { ...post, myVote: (post.voters || {})[uid] || 0, voters: undefined },
      comments: cmts.map(c => ({ ...c, myVote: (c.voters || {})[uid] || 0, voters: undefined })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /posts/:id ─────────────────────────────────
router.delete('/posts/:id', authMiddleware, async (req, res) => {
  try {
    const col  = await postsCol();
    const post = await col.findOne({ _id: req.params.id });
    if (!post) return res.status(404).json({ error: 'Không tìm thấy' });
    if (post.authorId !== String(req.user.id) && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Không có quyền xóa bài này' });
    const deletedBy = req.user.role === 'admin' && post.authorId !== String(req.user.id) ? 'admin' : 'user';
    await col.updateOne({ _id: req.params.id }, { $set: {
      deleted: true, deletedBy, deletedAt: now(), deletedReason: 'Người dùng tự xóa',
      recheckCount: 0, recheckPassed: false,
      appeal: { status: 'none', message: '', appealedAt: null, resolvedAt: null, adminNote: null },
    }});
    // Soft-delete comments của bài này
    const cmtCol  = await cmtsCol();
    const allCmts = await cmtCol.find({}, { limit: 5000 }).toArray();
    const toDelete = allCmts.filter(c => c.postId === req.params.id && !c.deleted);
    for (const c of toDelete) await cmtCol.updateOne({ _id: c._id }, { $set: { deleted: true, deletedBy, deletedAt: now() } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /posts/:id/vote ──────────────────────────────
router.post('/posts/:id/vote', authMiddleware, async (req, res) => {
  try {
    const vote = parseInt(req.body.vote);
    if (![1, -1, 0].includes(vote))
      return res.status(400).json({ error: 'vote phải là 1, -1 hoặc 0' });
    const col  = await postsCol();
    const post = await col.findOne({ _id: req.params.id });
    if (!post) return res.status(404).json({ error: 'Không tìm thấy' });
    const uid    = String(req.user.id);
    const voters = { ...(post.voters || {}) };
    const prev   = voters[uid] || 0;
    let up = post.upvotes, dn = post.downvotes;
    if (prev ===  1) up--;
    else if (prev === -1) dn--;
    if (vote ===  1) up++;
    else if (vote === -1) dn++;
    if (vote === 0) delete voters[uid];
    else voters[uid] = vote;
    await col.updateOne(
      { _id: req.params.id },
      { $set: { upvotes: up, downvotes: dn, voters, updatedAt: now() } }
    );
    res.json({ upvotes: up, downvotes: dn, myVote: vote });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /posts/:id/pin (admin only) ──────────────────
router.post('/posts/:id/pin', adminMiddleware, async (req, res) => {
  try {
    const col  = await postsCol();
    const post = await col.findOne({ _id: req.params.id });
    if (!post) return res.status(404).json({ error: 'Không tìm thấy' });
    const pinned = !post.pinned;
    await col.updateOne({ _id: req.params.id }, { $set: { pinned, updatedAt: now() } });
    res.json({ pinned });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /posts/:id/comments ──────────────────────────
router.post('/posts/:id/comments', authMiddleware, async (req, res) => {
  try {    if (!checkForumRate(commentRateMap, req.user.id, 15))
      return res.status(429).json({ error: 'Bạn bình luận quá nhiều. Vui lòng đợi 1 phút.' });    const { content, parentId } = req.body;
    if (!content?.trim())
      return res.status(400).json({ error: 'Nội dung không được để trống' });
    // Kiểm duyệt bình luận
    const modCheck = await moderateText(content.trim());
    if (!modCheck.allowed) {
      return res.status(422).json({
        error: `Bình luận không phù hợp${modCheck.reason ? ': ' + modCheck.reason : ''}. Vui lòng chỉnh sửa lại.`,
        moderated: true,
      });
    }
    const postCol = await postsCol();
    const post    = await postCol.findOne({ _id: req.params.id });
    if (!post) return res.status(404).json({ error: 'Bài viết không tồn tại' });
    let depth = 0;
    if (parentId) {
      const cmtCol = await cmtsCol();
      const parent = await cmtCol.findOne({ _id: String(parentId) });
      if (!parent)
        return res.status(404).json({ error: 'Bình luận cha không tồn tại' });
      depth = Math.min((parent.depth || 0) + 1, 1);
    }
    const ts  = now();
    const doc = {
      _id:         uuidv4(),
      postId:      req.params.id,
      parentId:    parentId ? String(parentId) : null,
      depth,
      authorId:    String(req.user.id),
      authorName:  req.user.fullName || 'Ẩn danh',
      authorRole:  req.user.role,
      authorClass: req.user.className || null,
      content:     content.trim().slice(0, 2000),
      upvotes:     0,
      downvotes:   0,
      voters:      {},
      scanned:     true, // đã qua AI moderation lúc đăng → không cần scan lại
      createdAt:   ts,
      updatedAt:   ts,
    };
    const cmtCol = await cmtsCol();
    await cmtCol.insertOne(doc);
    await postCol.updateOne(
      { _id: req.params.id },
      { $set: { commentCount: (post.commentCount || 0) + 1, updatedAt: now() } }
    );
    res.json({ ...doc, voters: undefined, myVote: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /comments/:id ──────────────────────────────
router.delete('/comments/:id', authMiddleware, async (req, res) => {
  try {
    const cmtCol = await cmtsCol();
    const cmt    = await cmtCol.findOne({ _id: req.params.id });
    if (!cmt) return res.status(404).json({ error: 'Không tìm thấy' });
    if (cmt.authorId !== String(req.user.id) && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Không có quyền xóa bình luận này' });
    const deletedBy = req.user.role === 'admin' && cmt.authorId !== String(req.user.id) ? 'admin' : 'user';
    await cmtCol.updateOne({ _id: req.params.id }, { $set: {
      deleted: true, deletedBy, deletedAt: now(), deletedReason: 'Người dùng tự xóa',
      recheckCount: 0, recheckPassed: false,
      appeal: { status: 'none', message: '', appealedAt: null, resolvedAt: null, adminNote: null },
    }});
    const postCol = await postsCol();
    const post    = await postCol.findOne({ _id: cmt.postId });
    if (post) {
      await postCol.updateOne(
        { _id: cmt.postId },
        { $set: { commentCount: Math.max(0, (post.commentCount || 1) - 1), updatedAt: now() } }
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /comments/:id/vote ───────────────────────────
router.post('/comments/:id/vote', authMiddleware, async (req, res) => {
  try {
    const vote = parseInt(req.body.vote);
    if (![1, -1, 0].includes(vote))
      return res.status(400).json({ error: 'vote phải là 1, -1 hoặc 0' });
    const col = await cmtsCol();
    const cmt = await col.findOne({ _id: req.params.id });
    if (!cmt) return res.status(404).json({ error: 'Không tìm thấy' });
    const uid    = String(req.user.id);
    const voters = { ...(cmt.voters || {}) };
    const prev   = voters[uid] || 0;
    let up = cmt.upvotes, dn = cmt.downvotes;
    if (prev ===  1) up--;
    else if (prev === -1) dn--;
    if (vote ===  1) up++;
    else if (vote === -1) dn++;
    if (vote === 0) delete voters[uid];
    else voters[uid] = vote;
    await col.updateOne(
      { _id: req.params.id },
      { $set: { upvotes: up, downvotes: dn, voters, updatedAt: now() } }
    );
    res.json({ upvotes: up, downvotes: dn, myVote: vote });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /warnings — cảnh báo chưa đọc của user ───────
// Warnings được lưu trong user.forumWarnings[] để tránh tạo collection mới
router.get('/warnings', authMiddleware, async (req, res) => {
  try {
    const UserModel = getUserModel();
    const user = await UserModel.findById(String(req.user.id));
    if (!user) return res.json([]);
    const unread = (user.forumWarnings || []).filter(w => !w.read);
    if (unread.length > 0) {
      user.forumWarnings = (user.forumWarnings || []).map(w => ({ ...w, read: true }));
      await user.save();
    }
    res.json(unread);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Hàm scan nội dung vi phạm (dùng chung cho route và auto-scan) ──
async function runForumScan() {
  const pCol      = await postsCol();
  const cCol      = await cmtsCol();
  const UserModel = getUserModel();

  // Incremental: chỉ lấy bài/comment chưa scan (dữ liệu cũ trước khi có moderation)
  const allPosts    = await pCol.find({}, { limit: 2000 }).toArray();
  // titleChecked: flag đánh dấu bài đã được AI kiểm tra rule tiêu đề không khớp nội dung
  // Bài cũ chưa có flag này sẽ được re-scan một lần, sau đó bỏ qua ở các lần scan tiếp
  // Chỉ scan bài chưa bị xóa — tránh re-process bài đã soft-delete
  const unscannedPosts = allPosts.filter(p => !p.deleted && (!p.scanned || !p.titleChecked));
  const allCmts     = await cCol.find({}, { limit: 10000 }).toArray();
  const unscannedCmts  = allCmts.filter(c => !c.deleted && !c.scanned);

  let deletedPosts = 0, deletedCmts = 0;
  const deletedPostIds = new Set();

  async function addWarning(userId, type, message) {
    try {
      const u = await UserModel.findById(String(userId));
      if (!u) return;
      u.forumWarnings = [...(u.forumWarnings || []), {
        _id: uuidv4(), type, message, createdAt: now(), read: false,
      }];
      await u.save();
    } catch (_) {}
  }

  // Bài viết: dùng AI (moderateText) — có đủ context để phán lạc chủ đề
  for (const post of unscannedPosts) {
    const tagText = Array.isArray(post.tags) ? post.tags.join(' ') : '';
    const text = (post.title || '') + ' ' + (post.content || '') + (tagText ? ' ' + tagText : '');
    const mod = await moderateText(text, post.title || '');
    if (!mod.allowed) {
      const softDeleteData = {
        deleted: true, deletedBy: 'ai', deletedAt: now(),
        deletedReason: mod.reason || 'vi phạm quy tắc cộng đồng',
        recheckCount: 0, recheckPassed: false,
        appeal: { status: 'none', message: '', appealedAt: null, resolvedAt: null, adminNote: null },
      };
      await pCol.updateOne({ _id: post._id }, { $set: softDeleteData });
      deletedPostIds.add(post._id);
      // Soft delete luôn comment của bài vi phạm
      const related = allCmts.filter(c => c.postId === post._id && !c.deleted);
      for (const c of related) {
        await cCol.updateOne({ _id: c._id }, { $set: {
          deleted: true, deletedBy: 'ai', deletedAt: now(),
          deletedReason: 'Bài viết chứa comment này đã bị xóa do vi phạm',
          recheckCount: 0, recheckPassed: false,
          appeal: { status: 'none', message: '', appealedAt: null, resolvedAt: null, adminNote: null },
        }});
      }
      deletedPosts++;
      await addWarning(
        post.authorId, 'post_deleted',
        `⚠️ Bài viết "${post.title.slice(0, 60)}" của bạn đã bị xóa.\nLý do: ${mod.reason || 'vi phạm quy tắc cộng đồng'}.\nNếu bạn cho rằng đây là nhầm lẫn, hãy liên hệ admin.`
      );
    } else {
      // Đánh dấu đã scan + đã kiểm tra title-content mismatch để lần sau bỏ qua
      await pCol.updateOne({ _id: post._id }, { $set: { scanned: true, titleChecked: true } });
    }
  }

  // Quét title gibberish + keyword tags trên TẤT CẢ bài viết đang active (kể cả đã scan)
  // isTitleGibberish và keywordBlock đều miễn phí, không tốn API — an toàn khi chạy toàn bộ
  const allActivePosts = allPosts.filter(p => !p.deleted && !deletedPostIds.has(p._id));
  for (const post of allActivePosts) {
    // 1. Kiểm tra tiêu đề ngẫu nhiên (bắt bài cũ đã scan trước khi có bộ lọc)
    let mod = null;
    if (isTitleGibberish(post.title || '')) {
      mod = { blocked: true, reason: 'Tiêu đề bài viết chứa ký tự ngẫu nhiên, không có ý nghĩa' };
    }
    // 2. Kiểm tra keyword trên tags
    if (!mod) {
      const tagText = Array.isArray(post.tags) ? post.tags.join(' ') : '';
      if (tagText) {
        const kwMod = keywordBlock(tagText);
        if (kwMod.blocked) mod = { blocked: true, reason: `Tag không phù hợp: ${kwMod.reason || 'vi phạm quy tắc cộng đồng'}` };
      }
    }
    if (mod && mod.blocked) {
      const softDeleteData = {
        deleted: true, deletedBy: 'ai', deletedAt: now(),
        deletedReason: mod.reason || 'vi phạm quy tắc cộng đồng',
        recheckCount: 0, recheckPassed: false,
        appeal: { status: 'none', message: '', appealedAt: null, resolvedAt: null, adminNote: null },
      };
      await pCol.updateOne({ _id: post._id }, { $set: softDeleteData });
      deletedPostIds.add(post._id);
      const related = allCmts.filter(c => c.postId === post._id && !c.deleted);
      for (const c of related) {
        await cCol.updateOne({ _id: c._id }, { $set: {
          deleted: true, deletedBy: 'ai', deletedAt: now(),
          deletedReason: 'Bài viết chứa comment này đã bị xóa do vi phạm',
          recheckCount: 0, recheckPassed: false,
          appeal: { status: 'none', message: '', appealedAt: null, resolvedAt: null, adminNote: null },
        }});
      }
      deletedPosts++;
      await addWarning(
        post.authorId, 'post_deleted',
        `⚠️ Bài viết "${post.title.slice(0, 60)}" của bạn đã bị xóa.\nLý do: ${mod.reason || 'vi phạm quy tắc cộng đồng'}.\nNếu bạn cho rằng đây là nhầm lẫn, hãy liên hệ admin.`
      );
    }
  }

  // Bình luận: dùng keyword-only (keywordBlock) — chạy trên TẤT CẢ comment (kể cả đã scan)
  // vì keyword check miễn phí và rules có thể được cập nhật sau khi comment đã được duyệt
  const allActiveCmts = allCmts.filter(c => !c.deleted && !deletedPostIds.has(c.postId));
  for (const cmt of allActiveCmts) {
    const mod = keywordBlock(cmt.content || '');
    if (mod.blocked) {      await cCol.updateOne({ _id: cmt._id }, { $set: {
        deleted: true, deletedBy: 'ai', deletedAt: now(),
        deletedReason: mod.reason || 'vi phạm quy tắc cộng đồng',
        recheckCount: 0, recheckPassed: false,
        appeal: { status: 'none', message: '', appealedAt: null, resolvedAt: null, adminNote: null },
      }});
      const post = await pCol.findOne({ _id: cmt.postId });
      if (post && !post.deleted) {
        await pCol.updateOne(
          { _id: cmt.postId },
          { $set: { commentCount: Math.max(0, (post.commentCount || 1) - 1), updatedAt: now() } }
        );
      }
      deletedCmts++;
      const snippet = (cmt.content || '').slice(0, 80);
      await addWarning(
        cmt.authorId, 'comment_deleted',
        `⚠️ Bình luận của bạn đã bị xóa.\nNội dung: "${snippet}${snippet.length === 80 ? '...' : ''}"\nLý do: ${mod.reason || 'vi phạm quy tắc cộng đồng'}.\nNếu bạn cho rằng đây là nhầm lẫn, hãy liên hệ admin.`
      );
    } else {
      // Đánh dấu đã scan để lần sau bỏ qua
      await cCol.updateOne({ _id: cmt._id }, { $set: { scanned: true } });
    }
  }

  return { deletedPosts, deletedCmts, scannedPosts: unscannedPosts.length, scannedCmts: unscannedCmts.length };
}

// ── GET /my-deleted — bài/comment bị xóa của user hiện tại ──
router.get('/my-deleted', authMiddleware, async (req, res) => {
  try {
    const uid  = String(req.user.id);
    const pCol = await postsCol();
    const cCol = await cmtsCol();
    const allPosts = await pCol.find({}, { limit: 2000 }).toArray();
    const allCmts  = await cCol.find({}, { limit: 10000 }).toArray();
    const posts = allPosts.filter(p => p.deleted && p.authorId === uid && p.deletedBy !== 'admin');
    const cmts  = allCmts.filter(c => c.deleted && c.authorId === uid && c.deletedBy !== 'admin');
    // Tự purge bài > 30 ngày không có appeal pending
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    for (const p of allPosts.filter(x => x.deleted && (!x.deletedAt || x.deletedAt < cutoff) && (!x.appeal || x.appeal.status === 'none' || x.appeal.status === 'rejected'))) {
      await pCol.deleteOne({ _id: p._id });
      const related = allCmts.filter(c => c.postId === p._id);
      for (const c of related) await cCol.deleteOne({ _id: c._id });
    }
    for (const c of allCmts.filter(x => x.deleted && (!x.deletedAt || x.deletedAt < cutoff) && (!x.appeal || x.appeal.status === 'none' || x.appeal.status === 'rejected'))) {
      await cCol.deleteOne({ _id: c._id });
    }
    res.json({ posts, comments: cmts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /posts/:id/restore — khôi phục bài viết ──────
router.post('/posts/:id/restore', authMiddleware, async (req, res) => {
  try {
    const col  = await postsCol();
    const post = await col.findOne({ _id: req.params.id });
    if (!post || !post.deleted) return res.status(404).json({ error: 'Không tìm thấy' });
    if (post.authorId !== String(req.user.id)) return res.status(403).json({ error: 'Không có quyền' });
    const adminApproved = post.appeal && post.appeal.status === 'approved';
    const canRestore    = post.deletedBy === 'user' || post.recheckPassed || adminApproved;
    if (!canRestore) return res.status(403).json({ error: 'Bài viết này cần được AI hoặc admin duyệt trước khi đăng lại' });
    if (!adminApproved) {
      // Kiểm duyệt AI lại trước khi đăng
      const text = (post.title || '') + ' ' + (post.content || '');
      const mod  = await moderateText(text);
      if (!mod.allowed) return res.status(422).json({ error: `Bài viết vẫn không phù hợp: ${mod.reason || 'vi phạm quy tắc'}`, moderated: true });
    }
    // Restore
    await col.updateOne({ _id: req.params.id }, { $set: {
      deleted: false, deletedBy: null, deletedAt: null, deletedReason: null,
      recheckCount: 0, recheckPassed: false,
      appeal: { status: 'none', message: '', appealedAt: null, resolvedAt: null, adminNote: null },
      scanned: true, updatedAt: now(),
    }});
    // Restore comments bị xóa cùng lúc với bài (deletedBy = same, cùng deletedAt)
    const cCol = await cmtsCol();
    const allC = await cCol.find({}, { limit: 5000 }).toArray();
    for (const c of allC.filter(c => c.postId === req.params.id && c.deleted && c.deletedBy === post.deletedBy)) {
      await cCol.updateOne({ _id: c._id }, { $set: { deleted: false, deletedBy: null, deletedAt: null, updatedAt: now() } });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /posts/:id/recheck — AI kiểm tra lại (tối đa 2 lần) ──
router.post('/posts/:id/recheck', authMiddleware, async (req, res) => {
  try {
    const col  = await postsCol();
    const post = await col.findOne({ _id: req.params.id });
    if (!post || !post.deleted) return res.status(404).json({ error: 'Không tìm thấy' });
    if (post.authorId !== String(req.user.id)) return res.status(403).json({ error: 'Không có quyền' });
    if (post.deletedBy !== 'ai') return res.status(400).json({ error: 'Chỉ dùng được với bài bị AI xóa' });
    const recheckCount = (post.recheckCount || 0);
    if (recheckCount >= 2) return res.status(429).json({ error: 'Đã dùng hết 2 lần kiểm tra lại', exhausted: true });
    const text = (post.title || '') + ' ' + (post.content || '');
    const mod  = await moderateText(text);
    const newCount = recheckCount + 1;
    if (mod.allowed) {
      await col.updateOne({ _id: req.params.id }, { $set: { recheckCount: newCount, recheckPassed: true } });
      return res.json({ allowed: true, recheckCount: newCount });
    } else {
      await col.updateOne({ _id: req.params.id }, { $set: { recheckCount: newCount, recheckPassed: false } });
      return res.json({ allowed: false, reason: mod.reason, recheckCount: newCount, exhausted: newCount >= 2 });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /posts/:id/appeal — phản hồi admin ───────────
router.post('/posts/:id/appeal', authMiddleware, async (req, res) => {
  try {
    const message = String(req.body.message || '').trim().slice(0, 500);
    if (!message) return res.status(400).json({ error: 'Vui lòng nhập nội dung phản hồi' });
    const col  = await postsCol();
    const post = await col.findOne({ _id: req.params.id });
    if (!post || !post.deleted) return res.status(404).json({ error: 'Không tìm thấy' });
    if (post.authorId !== String(req.user.id)) return res.status(403).json({ error: 'Không có quyền' });
    if (post.appeal && post.appeal.status === 'pending') return res.status(400).json({ error: 'Đã có phản hồi đang chờ xử lý' });
    await col.updateOne({ _id: req.params.id }, { $set: {
      appeal: { status: 'pending', message, appealedAt: now(), resolvedAt: null, adminNote: null },
    }});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /comments/:id/restore ────────────────────────
router.post('/comments/:id/restore', authMiddleware, async (req, res) => {
  try {
    const col = await cmtsCol();
    const cmt = await col.findOne({ _id: req.params.id });
    if (!cmt || !cmt.deleted) return res.status(404).json({ error: 'Không tìm thấy' });
    if (cmt.authorId !== String(req.user.id)) return res.status(403).json({ error: 'Không có quyền' });
    const adminApproved = cmt.appeal && cmt.appeal.status === 'approved';
    const canRestore    = cmt.deletedBy === 'user' || cmt.recheckPassed || adminApproved;
    if (!canRestore) return res.status(403).json({ error: 'Bình luận này cần được AI hoặc admin duyệt trước' });
    if (!adminApproved) {
      const mod = await moderateText(cmt.content || '');
      if (!mod.allowed) return res.status(422).json({ error: `Bình luận vẫn không phù hợp: ${mod.reason || 'vi phạm quy tắc'}`, moderated: true });
    }
    await col.updateOne({ _id: req.params.id }, { $set: {
      deleted: false, deletedBy: null, deletedAt: null, deletedReason: null,
      recheckCount: 0, recheckPassed: false,
      appeal: { status: 'none', message: '', appealedAt: null, resolvedAt: null, adminNote: null },
      scanned: true, updatedAt: now(),
    }});
    const postCol = await postsCol();
    const post    = await postCol.findOne({ _id: cmt.postId });
    if (post && !post.deleted) {
      await postCol.updateOne({ _id: cmt.postId }, { $set: { commentCount: (post.commentCount || 0) + 1, updatedAt: now() } });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /comments/:id/recheck ────────────────────────
router.post('/comments/:id/recheck', authMiddleware, async (req, res) => {
  try {
    const col = await cmtsCol();
    const cmt = await col.findOne({ _id: req.params.id });
    if (!cmt || !cmt.deleted) return res.status(404).json({ error: 'Không tìm thấy' });
    if (cmt.authorId !== String(req.user.id)) return res.status(403).json({ error: 'Không có quyền' });
    if (cmt.deletedBy !== 'ai') return res.status(400).json({ error: 'Chỉ dùng được với bình luận bị AI xóa' });
    const recheckCount = (cmt.recheckCount || 0);
    if (recheckCount >= 2) return res.status(429).json({ error: 'Đã dùng hết 2 lần kiểm tra lại', exhausted: true });
    const mod = await moderateText(cmt.content || '');
    const newCount = recheckCount + 1;
    if (mod.allowed) {
      await col.updateOne({ _id: req.params.id }, { $set: { recheckCount: newCount, recheckPassed: true } });
      return res.json({ allowed: true, recheckCount: newCount });
    } else {
      await col.updateOne({ _id: req.params.id }, { $set: { recheckCount: newCount, recheckPassed: false } });
      return res.json({ allowed: false, reason: mod.reason, recheckCount: newCount, exhausted: newCount >= 2 });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /comments/:id/appeal ─────────────────────────
router.post('/comments/:id/appeal', authMiddleware, async (req, res) => {
  try {
    const message = String(req.body.message || '').trim().slice(0, 500);
    if (!message) return res.status(400).json({ error: 'Vui lòng nhập nội dung phản hồi' });
    const col = await cmtsCol();
    const cmt = await col.findOne({ _id: req.params.id });
    if (!cmt || !cmt.deleted) return res.status(404).json({ error: 'Không tìm thấy' });
    if (cmt.authorId !== String(req.user.id)) return res.status(403).json({ error: 'Không có quyền' });
    if (cmt.appeal && cmt.appeal.status === 'pending') return res.status(400).json({ error: 'Đã có phản hồi đang chờ xử lý' });
    await col.updateOne({ _id: req.params.id }, { $set: {
      appeal: { status: 'pending', message, appealedAt: now(), resolvedAt: null, adminNote: null },
    }});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /my-deleted/post/:id/mark-seen — học sinh đánh dấu đã xem bài bị xóa ──
router.post('/my-deleted/post/:id/mark-seen', authMiddleware, async (req, res) => {
  try {
    const col  = await postsCol();
    const post = await col.findOne({ _id: req.params.id });
    if (!post || post.authorId !== String(req.user.id)) return res.status(403).json({ error: 'Không có quyền' });
    await col.updateOne({ _id: req.params.id }, { $set: { deletedSeen: true } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /my-deleted/comment/:id/mark-seen — học sinh đánh dấu đã xem comment bị xóa ──
router.post('/my-deleted/comment/:id/mark-seen', authMiddleware, async (req, res) => {
  try {
    const col = await cmtsCol();
    const cmt = await col.findOne({ _id: req.params.id });
    if (!cmt || cmt.authorId !== String(req.user.id)) return res.status(403).json({ error: 'Không có quyền' });
    await col.updateOne({ _id: req.params.id }, { $set: { deletedSeen: true } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /admin/appeals — admin xem danh sách phản hồi ──
router.get('/admin/appeals', adminMiddleware, async (req, res) => {
  try {
    const pCol = await postsCol();
    const cCol = await cmtsCol();
    const allPosts = await pCol.find({}, { limit: 2000 }).toArray();
    const allCmts  = await cCol.find({}, { limit: 10000 }).toArray();
    const posts = allPosts.filter(p => p.deleted && p.appeal && p.appeal.status === 'pending')
      .map(p => ({ ...p, itemType: 'post' }));
    const cmts  = allCmts.filter(c => c.deleted && c.appeal && c.appeal.status === 'pending')
      .map(c => ({ ...c, itemType: 'comment' }));
    const appeals = [...posts, ...cmts].sort((a, b) => new Date(a.appeal.appealedAt) - new Date(b.appeal.appealedAt));
    res.json(appeals);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /admin/appeals/:type/:id/mark-seen — admin đánh dấu đã xem đơn phản hồi ──
router.post('/admin/appeals/:type/:id/mark-seen', adminMiddleware, async (req, res) => {
  try {
    const { type, id } = req.params;
    if (type !== 'post' && type !== 'comment') return res.status(400).json({ error: 'Loại không hợp lệ' });
    const col = type === 'post' ? await postsCol() : await cmtsCol();
    const item = await col.findOne({ _id: id });
    if (!item || !item.deleted) return res.status(404).json({ error: 'Không tìm thấy' });
    await col.updateOne({ _id: id }, { $set: { 'appeal.adminSeen': true } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /admin/appeals/post/:id/approve ─────────────
router.post('/admin/appeals/post/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const col  = await postsCol();
    const post = await col.findOne({ _id: req.params.id });
    if (!post || !post.deleted) return res.status(404).json({ error: 'Không tìm thấy' });
    const adminNote = String(req.body.adminNote || '').trim().slice(0, 300);
    await col.updateOne({ _id: req.params.id }, { $set: {
      'appeal.status': 'approved', 'appeal.resolvedAt': now(), 'appeal.adminNote': adminNote,
    }});
    // Thông báo cho học sinh
    const UserModel = getUserModel();
    const u = await UserModel.findById(String(post.authorId));
    if (u) {
      u.forumWarnings = [...(u.forumWarnings || []), {
        _id: uuidv4(), type: 'appeal_approved',
        message: `✅ Phản hồi của bạn về bài viết "${(post.title || '').slice(0, 60)}" đã được admin chấp thuận. Bạn có thể vào "Bài đã xóa" để quyết định đăng lại.`,
        createdAt: now(), read: false,
      }];
      await u.save();
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /admin/appeals/post/:id/reject ──────────────
router.post('/admin/appeals/post/:id/reject', adminMiddleware, async (req, res) => {
  try {
    const col  = await postsCol();
    const post = await col.findOne({ _id: req.params.id });
    if (!post || !post.deleted) return res.status(404).json({ error: 'Không tìm thấy' });
    const adminNote = String(req.body.adminNote || '').trim().slice(0, 300);
    await col.updateOne({ _id: req.params.id }, { $set: {
      'appeal.status': 'rejected', 'appeal.resolvedAt': now(), 'appeal.adminNote': adminNote,
    }});
    const UserModel = getUserModel();
    const u = await UserModel.findById(String(post.authorId));
    if (u) {
      u.forumWarnings = [...(u.forumWarnings || []), {
        _id: uuidv4(), type: 'appeal_rejected',
        message: `❌ Phản hồi của bạn về bài viết "${(post.title || '').slice(0, 60)}" đã bị từ chối.${adminNote ? ' Ghi chú: ' + adminNote : ''}`,
        createdAt: now(), read: false,
      }];
      await u.save();
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /admin/appeals/comment/:id/approve ──────────
router.post('/admin/appeals/comment/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const col = await cmtsCol();
    const cmt = await col.findOne({ _id: req.params.id });
    if (!cmt || !cmt.deleted) return res.status(404).json({ error: 'Không tìm thấy' });
    const adminNote = String(req.body.adminNote || '').trim().slice(0, 300);
    await col.updateOne({ _id: req.params.id }, { $set: {
      'appeal.status': 'approved', 'appeal.resolvedAt': now(), 'appeal.adminNote': adminNote,
    }});
    const UserModel = getUserModel();
    const u = await UserModel.findById(String(cmt.authorId));
    if (u) {
      u.forumWarnings = [...(u.forumWarnings || []), {
        _id: uuidv4(), type: 'appeal_approved',
        message: `✅ Phản hồi của bạn về một bình luận đã được admin chấp thuận. Bạn có thể vào "Bài đã xóa" để quyết định đăng lại.`,
        createdAt: now(), read: false,
      }];
      await u.save();
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /admin/appeals/comment/:id/reject ────────────
router.post('/admin/appeals/comment/:id/reject', adminMiddleware, async (req, res) => {
  try {
    const col = await cmtsCol();
    const cmt = await col.findOne({ _id: req.params.id });
    if (!cmt || !cmt.deleted) return res.status(404).json({ error: 'Không tìm thấy' });
    const adminNote = String(req.body.adminNote || '').trim().slice(0, 300);
    await col.updateOne({ _id: req.params.id }, { $set: {
      'appeal.status': 'rejected', 'appeal.resolvedAt': now(), 'appeal.adminNote': adminNote,
    }});
    const UserModel = getUserModel();
    const u = await UserModel.findById(String(cmt.authorId));
    if (u) {
      u.forumWarnings = [...(u.forumWarnings || []), {
        _id: uuidv4(), type: 'appeal_rejected',
        message: `❌ Phản hồi của bạn về một bình luận đã bị từ chối.${adminNote ? ' Ghi chú: ' + adminNote : ''}`,
        createdAt: now(), read: false,
      }];
      await u.save();
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /admin/scan — admin quét & xóa nội dung vi phạm ──
// Dùng keywordBlock thay vì AI để tránh rate limit khi quét hàng loạt
router.post('/admin/scan', adminMiddleware, async (req, res) => {
  try {
    const result = await runForumScan();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auto-scan mỗi 15 phút ─────────────────────────
function startAutoScan() {
  const INTERVAL = 15 * 60 * 1000; // 15 phút
  setInterval(async () => {
    try {
      const { deletedPosts, deletedCmts } = await runForumScan();
      if (deletedPosts || deletedCmts) {
        console.log(`[AutoScan] Xóa ${deletedPosts} bài, ${deletedCmts} bình luận vi phạm`);
      }
    } catch (e) {
      if (/session has been destroyed/i.test(e.message)) {
        // Astra DB HTTP connection bị đóng — xóa cache, thử lại một lần
        clearCollectionCache('forum_posts', 'forum_comments', 'users');
        try {
          const { deletedPosts, deletedCmts } = await runForumScan();
          if (deletedPosts || deletedCmts) {
            console.log(`[AutoScan] Xóa ${deletedPosts} bài, ${deletedCmts} bình luận vi phạm`);
          }
        } catch (e2) {
          console.error('[AutoScan] Lỗi sau retry:', e2.message);
        }
      } else {
        console.error('[AutoScan] Lỗi:', e.message);
      }
    }
  }, INTERVAL);
  console.log('⏰  Forum auto-scan bắt đầu (mỗi 15 phút)');
}

module.exports = { router, startAutoScan };
