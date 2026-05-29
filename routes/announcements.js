'use strict';
/**
 * routes/announcements.js — Thông báo nội bộ nhà trường
 *
 * GET    /api/announcements      — Lấy danh sách (authMiddleware)
 * POST   /api/announcements      — Đăng mới (teacherMiddleware)
 * DELETE /api/announcements/:id  — Xóa (teacherMiddleware, chủ sở hữu hoặc admin)
 */

const router = require('express').Router();
const { authMiddleware, teacherMiddleware } = require('../middleware/auth');
const { AnnouncementModel } = require('../db');

// Lấy danh sách thông báo (tất cả người dùng đã đăng nhập)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const announcements = await AnnouncementModel.find(50);
    res.json(announcements);
  } catch (err) {
    console.error('[Ann GET]', err.message);
    res.status(500).json({ error: 'Không thể tải thông báo' });
  }
});

// Đăng thông báo mới (giáo viên và admin)
router.post('/', teacherMiddleware, async (req, res) => {
  const content = String(req.body.content ?? '').trim();
  if (!content) return res.status(400).json({ error: 'Nội dung không được để trống' });
  if (content.length > 1000) return res.status(400).json({ error: 'Nội dung quá dài (tối đa 1000 ký tự)' });

  try {
    const userId = String(req.user.id || req.user._id || '');
    const doc = await AnnouncementModel.create({
      authorId: userId,
      authorName: req.user.fullName || req.user.username || 'Ẩn danh',
      authorRole: req.user.role,
      content,
    });
    res.status(201).json(doc);
  } catch (err) {
    console.error('[Ann POST]', err.message);
    res.status(500).json({ error: 'Không thể đăng thông báo' });
  }
});

// Xóa thông báo (chủ sở hữu hoặc admin)
router.delete('/:id', teacherMiddleware, async (req, res) => {
  const id = String(req.params.id);
  try {
    const ann = await AnnouncementModel.findById(id);
    if (!ann) return res.status(404).json({ error: 'Không tìm thấy thông báo' });

    const userId = String(req.user.id || req.user._id || '');
    const isOwner = String(ann.authorId) === userId;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Không có quyền xóa thông báo này' });
    }

    await AnnouncementModel.deleteById(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Ann DELETE]', err.message);
    res.status(500).json({ error: 'Không thể xóa thông báo' });
  }
});

module.exports = router;
