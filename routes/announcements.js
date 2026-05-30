'use strict';
/**
 * routes/announcements.js — Thông báo nội bộ nhà trường
 *
 * GET    /api/announcements         — Lấy danh sách (authMiddleware)
 * GET    /api/announcements/targets — Danh sách đối tượng nhận (teacherMiddleware)
 * POST   /api/announcements         — Đăng mới (teacherMiddleware)
 * DELETE /api/announcements/:id     — Xóa (teacherMiddleware, chủ sở hữu hoặc admin)
 */

const router = require('express').Router();
const { authMiddleware, teacherMiddleware } = require('../middleware/auth');
const { AnnouncementModel } = require('../db');
const { SchoolUserModel, EmailUserModel } = require('../db-supabase');

function normalizeClassName(v) {
  return String(v ?? '').trim().toUpperCase();
}

function normalizeTarget(raw) {
  const scope = String(raw?.scope || 'all').toLowerCase();
  const validScope = ['all', 'class', 'teachers', 'students'].includes(scope) ? scope : 'all';
  const classNames = Array.isArray(raw?.classNames)
    ? [...new Set(raw.classNames.map(normalizeClassName).filter(Boolean))]
    : [];
  const userIds = Array.isArray(raw?.userIds)
    ? [...new Set(raw.userIds.map(v => String(v || '').trim()).filter(Boolean))]
    : [];

  if (validScope === 'class' && !classNames.length) return { error: 'Vui lòng chọn ít nhất 1 lớp' };
  if ((validScope === 'teachers' || validScope === 'students') && !userIds.length) {
    return { error: 'Vui lòng chọn ít nhất 1 người nhận' };
  }
  return {
    scope: validScope,
    classNames: validScope === 'class' ? classNames : [],
    userIds: validScope === 'teachers' || validScope === 'students' ? userIds : [],
  };
}

function summarizeTarget(target = {}) {
  const scope = target.scope || 'all';
  if (scope === 'all') return 'Toàn trường';
  if (scope === 'class') return `Lớp: ${(target.classNames || []).join(', ')}`;
  if (scope === 'teachers') return 'Giáo viên được chọn';
  if (scope === 'students') return 'Học sinh được chọn';
  return 'Toàn trường';
}

async function getCurrentUser(req) {
  const userId = String(req.user.id || req.user._id || '');
  let user = await EmailUserModel.findById(userId);
  if (!user) user = await SchoolUserModel.findById(userId);
  return user ? { ...user, _id: user._id || user.id } : null;
}

function canViewAnnouncement(ann, viewer) {
  if (!viewer) return false;
  if (viewer.role === 'admin') return true;

  const target = ann?.target || { scope: 'all' };
  const scope = target.scope || 'all';
  if (scope === 'all') return true;

  if (scope === 'class') {
    const userClass = normalizeClassName(viewer.className || viewer.class_name || '');
    return !!userClass && Array.isArray(target.classNames) && target.classNames.includes(userClass);
  }
  if (scope === 'teachers') {
    if (viewer.role !== 'teacher') return false;
    return Array.isArray(target.userIds) && target.userIds.includes(String(viewer._id || viewer.id || ''));
  }
  if (scope === 'students') {
    if (viewer.role !== 'student') return false;
    return Array.isArray(target.userIds) && target.userIds.includes(String(viewer._id || viewer.id || ''));
  }
  return true;
}

// Lấy danh sách đối tượng nhận để tạo thông báo (đặt trước GET /)
router.get('/targets', teacherMiddleware, async (req, res) => {
  try {
    const [schoolTeachers, schoolStudents] = await Promise.all([
      SchoolUserModel.find({ role: 'teacher' }).lean(),
      SchoolUserModel.find({ role: 'student' }).lean(),
    ]);

    const allClasses = [...new Set(
      schoolStudents
        .map(u => normalizeClassName(u.className || u.class_name || ''))
        .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, 'vi'));

    const teachersMap = new Map();
    schoolTeachers.forEach(u => {
      const id = String(u._id || u.id || '');
      if (!id) return;
      teachersMap.set(id, {
        id,
        fullName: u.fullName || u.full_name || u.username || 'Giáo viên',
        className: normalizeClassName(u.className || u.class_name || ''),
      });
    });

    const studentsMap = new Map();
    schoolStudents.forEach(u => {
      const id = String(u._id || u.id || '');
      if (!id) return;
      studentsMap.set(id, {
        id,
        fullName: u.fullName || u.full_name || u.username || 'Học sinh',
        className: normalizeClassName(u.className || u.class_name || ''),
      });
    });

    const teachers = [...teachersMap.values()].sort((a, b) => a.fullName.localeCompare(b.fullName, 'vi'));
    const allStudents = [...studentsMap.values()].sort((a, b) => {
      const c = a.className.localeCompare(b.className, 'vi');
      return c || a.fullName.localeCompare(b.fullName, 'vi');
    });

    if (req.user.role === 'admin') {
      return res.json({
        allowedScopes: ['all', 'class', 'teachers', 'students'],
        classes: allClasses,
        teachers,
        students: allStudents,
      });
    }

    // Giáo viên: mặc định gửi toàn trường; khi thu hẹp thì chọn lớp hoặc học sinh
    res.json({
      allowedScopes: ['all', 'class', 'students'],
      classes: allClasses,
      teachers: [],
      students: allStudents,
    });
  } catch (err) {
    console.error('[Ann TARGETS]', err.message);
    res.status(500).json({ error: 'Không thể tải danh sách đối tượng' });
  }
});

// Lấy danh sách thông báo (tất cả người dùng đã đăng nhập)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const viewer = await getCurrentUser(req);
    if (!viewer) return res.status(401).json({ error: 'Không tìm thấy người dùng' });

    const announcements = await AnnouncementModel.find(200);
    const visible = announcements
      .filter(a => canViewAnnouncement(a, viewer))
      .slice(0, 50)
      .map(a => ({ ...a, targetSummary: summarizeTarget(a.target) }));
    res.json(visible);
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
  const target = normalizeTarget(req.body.target || { scope: 'all' });
  if (target.error) return res.status(400).json({ error: target.error });
  
  // Teachers can use class or students scope; admins can use any scope
  if (req.user.role === 'teacher') {
    if (target.scope === 'teachers') {
      return res.status(400).json({ error: 'Giáo viên không thể gửi thông báo cho giáo viên khác' });
    }
  }

  try {
    const userId = String(req.user.id || req.user._id || '');

    // Lấy tên từ database để đảm bảo chính xác
    let authorName = req.user.fullName || 'Giáo viên';
    
    // Tìm trong cả hai bảng để lấy tên đầy đủ
    let user = await EmailUserModel.findById(userId);
    if (!user) user = await SchoolUserModel.findById(userId);
    if (user) {
      authorName = user.fullName || user.full_name || user.username || 'Giáo viên';
    }
    
    const doc = await AnnouncementModel.create({
      authorId: userId,
      authorName: authorName,
      authorRole: req.user.role,
      content,
      target,
    });
    res.status(201).json({ ...doc, targetSummary: summarizeTarget(doc.target) });
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
