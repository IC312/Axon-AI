'use strict';
const router = require('express').Router();
const { teacherMiddleware } = require('../middleware/auth');
const { getConnection, getChatModels } = require('../db');
const { SchoolUserModel, EmailUserModel } = require('../db-supabase');

router.use(teacherMiddleware);

// ── DB helpers ────────────────────────────────────────
async function getChatDB(grade) {
  const c = await getConnection(grade);
  return getChatModels(c);
}

async function getAllChatModels() {
  const results = await Promise.all(
    [6, 7, 8, 9].map(g => getConnection(g).then(c => getChatModels(c)))
  );
  return results;
}

function gradeFromClass(className) {
  const m = (className || '').match(/^(\d)/);
  return m ? parseInt(m[1]) : 9;
}

function sortClasses(a, b) {
  const parse = s => { const m = s.match(/^(\d+)[A-Za-z]+(\d+)$/); return m ? [+m[1], +m[2]] : [0, 0]; };
  const [ag, an] = parse(a);
  const [bg, bn] = parse(b);
  return ag !== bg ? ag - bg : an - bn;
}

function sortByGivenName(a, b) {
  const last = s => (s.fullName || '').split(' ').pop();
  return last(a).localeCompare(last(b), 'vi', { sensitivity: 'base' });
}

// ── GET /api/teacher/me ───────────────────────────────
router.get('/me', async (req, res) => {
  try {
    // Thử email_users trước (giáo viên ngoài), sau đó school_users (giáo viên trường)
    let teacher = await EmailUserModel.findById(req.user.id);
    if (teacher) {
      return res.json({
        _id:        String(teacher.id),
        fullName:   teacher.fullName || '',
        email:      teacher.email    || '',
        subject:    teacher.subject  || '',
        schoolName: teacher.schoolName || '',
        role:       teacher.role,
        authType:   'email',
      });
    }

    // CCCD-registered teacher stored in Supabase school_users
    const user = await SchoolUserModel.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Không tìm thấy giáo viên' });
    return res.json({
      _id:      String(user.id),
      fullName: user.fullName || '',
      email:    user.recoveryEmail || '',
      subject:  user.subject  || '',
      school:   user.school   || '',
      role:     user.role,
      authType: 'school',
    });
  } catch (err) {
    console.error('[Teacher/me]', err.message);
    res.status(500).json({ error: 'Lỗi máy chủ' });
  }
});

// ── GET /api/teacher/stats ────────────────────────────
// Fix: totalStudents/totalClasses must match teacher's assignedClasses
router.get('/stats', async (req, res) => {
  try {
    // Resolve assignedClasses like in /api/teacher/classes
    let assignedClasses = [];

    const emailTeacher = await EmailUserModel.findById(req.user.id);
    if (emailTeacher) {
      assignedClasses = emailTeacher.assignedClasses ?? [];
    } else {
      const schoolTeacher = await SchoolUserModel.findById(req.user.id);
      assignedClasses = schoolTeacher?.assignedClasses ?? [];
    }

    // If not configured yet, fall back to all classes that exist
    const allStudents = await SchoolUserModel.find({ role: 'student', className: { $ne: '' } }).lean();
    const allClasses = [...new Set(allStudents.map(s => s.className).filter(Boolean))];

    if (!assignedClasses.length) assignedClasses = allClasses;

    const existing = new Set(allClasses);
    const classes = assignedClasses.filter(c => existing.has(c)).sort(sortClasses);

    const students = allStudents.filter(s => classes.includes(s.className));

    const chatDBs = await getAllChatModels();
    const [convCounts, msgCounts] = await Promise.all([
      Promise.all(chatDBs.map(({ Conversation }) => Conversation.countDocuments())),
      Promise.all(chatDBs.map(({ Message }) => Message.countDocuments())),
    ]);
    const totalConvs = convCounts.reduce((a, b) => a + b, 0);
    const totalMsgs  = msgCounts.reduce((a, b) => a + b, 0);

    res.json({
      totalStudents: students.length,
      totalClasses: classes.length,
      totalConvs,
      totalMsgs,
    });
  } catch (err) {
    console.error('[Teacher/stats]', err.message);
    res.status(500).json({ error: 'Lỗi máy chủ' });
  }
});

// ── GET /api/teacher/classes ──────────────────────────
// Returns only the classes the teacher has been assigned to.
// If assignedClasses is empty (not yet configured), falls back to all classes.
router.get('/classes', async (req, res) => {
  try {
    let assignedClasses = [];

    // Thử email_users (giáo viên ngoài) trước
    const emailTeacher = await EmailUserModel.findById(req.user.id);
    if (emailTeacher) {
      assignedClasses = emailTeacher.assignedClasses ?? [];
    } else {
      // CCCD teacher — read from school_users
      const schoolTeacher = await SchoolUserModel.findById(req.user.id);
      assignedClasses = schoolTeacher?.assignedClasses ?? [];
    }

    const students = await SchoolUserModel.find({ role: 'student', className: { $ne: '' } }).lean();
    const allClasses = [...new Set(students.map(s => s.className))].sort(sortClasses);

    if (assignedClasses.length > 0) {
      const existing = new Set(allClasses);
      const filtered = assignedClasses.filter(c => existing.has(c)).sort(sortClasses);
      return res.json(filtered);
    }

    res.json(allClasses);
  } catch (err) {
    console.error('[Teacher/classes]', err.message);
    res.status(500).json({ error: 'Lỗi máy chủ' });
  }
});

// ── GET /api/teacher/classes/:className/students ──────
// Returns student list with AI usage stats (read-only, no sensitive data)
router.get('/classes/:className/students', async (req, res) => {
  try {
    const students = await SchoolUserModel.find({ role: 'student', className: req.params.className }).lean();
    students.sort(sortByGivenName);

    const grade = gradeFromClass(req.params.className);
    const { Conversation, Message } = await getChatDB(grade);

    const result = await Promise.all(students.map(async s => {
      const convIds = await Conversation.distinct('_id', { userId: s.id });
      const msgCount = await Message.countDocuments({ conversationId: { $in: convIds } });
      return {
        _id:       String(s.id),
        fullName:  s.fullName,
        className: s.className,
        gender:    s.gender || '',
        convCount: convIds.length,
        msgCount,
      };
    }));

    res.json(result);
  } catch (err) {
    console.error('[Teacher/class-students]', err.message);
    res.status(500).json({ error: 'Lỗi máy chủ' });
  }
});

module.exports = router;
