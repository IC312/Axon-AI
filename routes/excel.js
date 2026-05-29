'use strict';
/**
 * routes/excel.js — Import / Export / Template Excel cho học sinh và giáo viên (nội bộ)
 * Tất cả endpoints đều yêu cầu adminMiddleware.
 *
 * GET  /api/admin/excel/template/:type   — tải file Excel mẫu (students | teachers)
 * GET  /api/admin/excel/export/:type     — xuất dữ liệu hiện tại ra Excel
 * POST /api/admin/excel/import/:type     — nhập từ file Excel (multipart/form-data, field: "file")
 */

const router  = require('express').Router();
const multer  = require('multer');
const ExcelJS = require('exceljs');
const bcrypt  = require('bcryptjs');

const { adminMiddleware }      = require('../middleware/auth');
const { SchoolUserModel }      = require('../db-supabase');

router.use(adminMiddleware);

// Multer — lưu file trong bộ nhớ (không ghi ra đĩa)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter(_req, file, cb) {
    const ok = file.mimetype.includes('spreadsheet') ||
               file.mimetype.includes('excel') ||
               file.originalname.endsWith('.xlsx') ||
               file.originalname.endsWith('.xls');
    cb(ok ? null : new Error('Chỉ chấp nhận file .xlsx / .xls'), ok);
  },
});

// excel.js dùng SchoolUserModel trực tiếp (không cần helper riêng)

// ── Style helpers ─────────────────────────────────────────────────────────────
function applyHeaderStyle(ws, rowIdx, numCols) {
  const row = ws.getRow(rowIdx);
  for (let c = 1; c <= numCols; c++) {
    const cell = row.getCell(c);
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border    = {
      top:    { style: 'thin', color: { argb: 'FFD1D5DB' } },
      bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      left:   { style: 'thin', color: { argb: 'FFD1D5DB' } },
      right:  { style: 'thin', color: { argb: 'FFD1D5DB' } },
    };
  }
  row.height = 22;
  row.commit();
}

function applyDataStyle(ws, rowIdx, numCols) {
  const row = ws.getRow(rowIdx);
  const bg  = rowIdx % 2 === 0 ? 'FFF9FAFB' : 'FFFFFFFF';
  for (let c = 1; c <= numCols; c++) {
    row.getCell(c).fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    row.getCell(c).border = {
      top:    { style: 'hair', color: { argb: 'FFE5E7EB' } },
      bottom: { style: 'hair', color: { argb: 'FFE5E7EB' } },
      left:   { style: 'hair', color: { argb: 'FFE5E7EB' } },
      right:  { style: 'hair', color: { argb: 'FFE5E7EB' } },
    };
  }
  row.commit();
}

function addNoteRow(ws, text, numCols) {
  const row = ws.addRow([text]);
  ws.mergeCells(row.number, 1, row.number, numCols);
  const cell = row.getCell(1);
  cell.font      = { italic: true, color: { argb: 'FF6B7280' }, size: 10 };
  cell.alignment = { horizontal: 'left', wrapText: true };
  row.height = 18;
  row.commit();
}

// ═══════════════════════════════════════════════════════════════════════════════
// STUDENT TEMPLATE
// Cột: STT | Mã lớp | Họ và tên | Ngày sinh (DD/MM/YYYY) | Giới tính | Số CCCD
// ═══════════════════════════════════════════════════════════════════════════════
function buildStudentWorkbook(dataRows = null) {
  const wb  = new ExcelJS.Workbook();
  wb.creator = 'Axon AI';
  const ws  = wb.addWorksheet('Danh sách học sinh');

  ws.columns = [
    { key: 'stt',       width: 6  },
    { key: 'className', width: 8  },
    { key: 'fullName',  width: 28 },
    { key: 'dob',       width: 20 },
    { key: 'gender',    width: 12 },
    { key: 'cccd',      width: 16 },
  ];

  // Note rows
  if (!dataRows) {
    // Template only — add instruction rows
    addNoteRow(ws, '⚠️  Chú ý: Không xóa hoặc đổi thứ tự cột. Chỉ điền dữ liệu từ dòng 4 trở đi (dòng 3 là tiêu đề).', 6);
    addNoteRow(ws, '📌  Mật khẩu mặc định = Ngày sinh dạng DDMMYYYY (vd: 02/03/2014 → 02032014). Hệ thống sẽ tự tạo.', 6);
  }

  // Header
  const headerRow = ws.addRow(['STT', 'Mã lớp', 'Họ và tên', 'Ngày sinh (DD/MM/YYYY)', 'Giới tính', 'Số CCCD']);
  applyHeaderStyle(ws, headerRow.number, 6);

  if (dataRows && dataRows.length) {
    dataRows.forEach((d, i) => {
      ws.addRow([i + 1, d.className, d.fullName, d.dob, d.gender, d.cccd]);
      applyDataStyle(ws, ws.lastRow.number, 6);
    });
  } else {
    // Sample row
    ws.addRow([1, '6A1', 'Nguyễn Văn An', '01/01/2012', 'Nam', '012345678901']);
    applyDataStyle(ws, ws.lastRow.number, 6);
  }

  ws.getRow(1).frozen = true;
  return wb;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEACHER TEMPLATE
// Cột: STT | Họ và tên | Số CCCD | Mật khẩu mặc định
// ═══════════════════════════════════════════════════════════════════════════════
function buildTeacherWorkbook(dataRows = null) {
  const wb  = new ExcelJS.Workbook();
  wb.creator = 'Axon AI';
  const ws  = wb.addWorksheet('Danh sách giáo viên');

  ws.columns = [
    { key: 'stt',      width: 6  },
    { key: 'fullName', width: 30 },
    { key: 'cccd',     width: 16 },
    { key: 'password', width: 20 },
  ];

  if (!dataRows) {
    addNoteRow(ws, '⚠️  Chú ý: Không xóa hoặc đổi thứ tự cột. Chỉ điền dữ liệu từ dòng 4 trở đi (dòng 3 là tiêu đề).', 4);
    addNoteRow(ws, '📌  Giáo viên sẽ bị yêu cầu đổi mật khẩu sau lần đăng nhập đầu tiên.', 4);
  }

  const headerRow = ws.addRow(['STT', 'Họ và tên', 'Số CCCD', 'Mật khẩu mặc định']);
  applyHeaderStyle(ws, headerRow.number, 4);

  if (dataRows && dataRows.length) {
    dataRows.forEach((d, i) => {
      ws.addRow([i + 1, d.fullName, d.cccd, '(đã hash)']);
      applyDataStyle(ws, ws.lastRow.number, 4);
    });
  } else {
    ws.addRow([1, 'Nguyễn Thị Bình', '012345678902', 'matkhau123']);
    applyDataStyle(ws, ws.lastRow.number, 4);
  }

  ws.getRow(1).frozen = true;
  return wb;
}

async function sendWorkbook(res, wb, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  await wb.xlsx.write(res);
  res.end();
}

// ── GET /template/:type ───────────────────────────────────────────────────────
router.get('/template/:type', async (req, res) => {
  try {
    const { type } = req.params;
    if (type === 'students') {
      const wb = buildStudentWorkbook(null);
      return sendWorkbook(res, wb, 'mau_hoc_sinh.xlsx');
    }
    if (type === 'teachers') {
      const wb = buildTeacherWorkbook(null);
      return sendWorkbook(res, wb, 'mau_giao_vien.xlsx');
    }
    res.status(400).json({ error: 'type phải là students hoặc teachers' });
  } catch (err) {
    console.error('[excel/template]', err.message);
    res.status(500).json({ error: 'Lỗi tạo file mẫu' });
  }
});

// ── GET /export/:type ─────────────────────────────────────────────────────────
router.get('/export/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const User = SchoolUserModel;
    const docs = await User.find({ role: type === 'teachers' ? 'teacher' : 'student' });

    if (type === 'students') {
      const rows = docs
        .filter(d => d.className)
        .sort((a, b) => {
          const parseClass = s => {
            const m = (s || '').match(/^(\d+)[A-Za-z]+(\d+)$/);
            return m ? [+m[1], +m[2]] : [0, 0];
          };
          const [ag, an] = parseClass(a.className);
          const [bg, bn] = parseClass(b.className);
          if (ag !== bg) return ag - bg;
          if (an !== bn) return an - bn;
          // Sắp theo tên (từ cuối) rồi mới đến họ — chuẩn danh sách học bạ VN
          const givenName = s => (s || '').trim().split(/\s+/).pop();
          const gCmp = givenName(a.fullName).localeCompare(givenName(b.fullName), 'vi', { sensitivity: 'base' });
          if (gCmp !== 0) return gCmp;
          return (a.fullName || '').localeCompare(b.fullName || '', 'vi', { sensitivity: 'base' });
        })
        .map(d => ({ className: d.className, fullName: d.fullName, dob: d.dob || '', gender: d.gender || '', cccd: d.cccd || '' }));
      return sendWorkbook(res, buildStudentWorkbook(rows), `hoc_sinh_${Date.now()}.xlsx`);
    }

    if (type === 'teachers') {
      const rows = docs.map(d => ({ fullName: d.fullName, cccd: d.cccd || '' }));
      return sendWorkbook(res, buildTeacherWorkbook(rows), `giao_vien_${Date.now()}.xlsx`);
    }

    res.status(400).json({ error: 'type phải là students hoặc teachers' });
  } catch (err) {
    console.error('[excel/export]', err.message);
    res.status(500).json({ error: 'Lỗi xuất dữ liệu' });
  }
});

// ── POST /import/:type ────────────────────────────────────────────────────────
router.post('/import/:type', upload.single('file'), async (req, res) => {
  try {
    const { type } = req.params;
    if (!req.file) return res.status(400).json({ error: 'Không nhận được file' });
    if (type !== 'students' && type !== 'teachers') {
      return res.status(400).json({ error: 'type phải là students hoặc teachers' });
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: 'File Excel không có sheet nào' });

    const User = SchoolUserModel;
    const BATCH   = 15;
    let created   = 0, skipped = 0, errors = 0;
    const errList = [];

    // Collect rows, skip note rows (merged/blank cells in col A are instructions) and header
    const dataRows = [];
    ws.eachRow((row, idx) => {
      const vals = row.values.slice(1); // ExcelJS is 1-based
      if (!vals[0]) return;             // skip blank / note rows
      const firstVal = String(vals[0]).trim();
      if (/^\d+$/.test(firstVal) === false) return; // skip if col A is not a number (header/note)
      dataRows.push(vals);
    });

    if (dataRows.length === 0) {
      return res.status(400).json({ error: 'Không tìm thấy dữ liệu hợp lệ trong file. Đảm bảo cột A là số thứ tự.' });
    }

    for (let i = 0; i < dataRows.length; i += BATCH) {
      const batch = dataRows.slice(i, i + BATCH);
      await Promise.all(batch.map(async (vals) => {
        try {
          if (type === 'students') {
            // STT | Mã lớp | Họ và tên | Ngày sinh | Giới tính | CCCD
            const [, className, fullName, dobRaw, gender, cccdRaw] = vals;
            const cccd = String(cccdRaw ?? '').trim().replace(/\D/g, '').padStart(12, '0');
            const name = String(fullName ?? '').trim();
            const cls  = String(className ?? '').trim().toUpperCase();

            if (!cccd || cccd.length !== 12 || !name || !cls) {
              errList.push(`Dòng thiếu dữ liệu: ${name || '?'}`);
              errors++;
              return;
            }

            const exists = await User.findOne({ $or: [{ cccd }, { fullName: name }] });
            if (exists) { skipped++; return; }
            let dobDisplay = String(dobRaw ?? '').trim();
            let dobStr = dobDisplay.replace(/\//g, '');
            if (dobRaw instanceof Date) {
              const d = String(dobRaw.getDate()).padStart(2, '0');
              const m = String(dobRaw.getMonth() + 1).padStart(2, '0');
              const y = dobRaw.getFullYear();
              dobDisplay = `${d}/${m}/${y}`;
              dobStr = `${d}${m}${y}`;
            }

            const passwordHash = await bcrypt.hash(dobStr || cccd.slice(-8), 10);
            await User.create({
              cccd, passwordHash,
              role: 'student',
              fullName: name,
              className: cls,
              gender: String(gender ?? '').trim(),
              dob: dobDisplay,
              mustChangePassword: true,
            });
            created++;

          } else {
            // STT | Họ và tên | CCCD | Mật khẩu mặc định
            const [, fullName, cccdRaw, password] = vals;
            const cccd = String(cccdRaw ?? '').trim().replace(/\D/g, '').padStart(12, '0');
            const name = String(fullName ?? '').trim();
            const pass = String(password ?? '').trim();

            if (!cccd || cccd.length !== 12 || !name || !pass) {
              errList.push(`Dòng thiếu dữ liệu: ${name || '?'}`);
              errors++;
              return;
            }

            const exists = await User.findOne({ $or: [{ cccd }, { fullName: name }] });
            if (exists) { skipped++; return; }

            const passwordHash= await bcrypt.hash(pass, 10);
            await User.create({
              cccd, passwordHash,
              role: 'teacher',
              fullName: name,
              mustChangePassword: true,
            });
            created++;
          }
        } catch (err) {
          errors++;
          errList.push(`Lỗi: ${err.message}`);
        }
      }));
    }

    res.json({ ok: true, created, skipped, errors, errList: errList.slice(0, 20) });
  } catch (err) {
    if (err.message && err.message.includes('xlsx')) {
      return res.status(400).json({ error: 'File không đúng định dạng Excel (.xlsx)' });
    }
    console.error('[excel/import]', err.message);
    res.status(500).json({ error: 'Lỗi xử lý file: ' + err.message });
  }
});

module.exports = router;
