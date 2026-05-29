/**
 * Import danh sách giáo viên từ file Excel do nhà trường cấp vào Astra DB.
 *
 * File Excel: scripts/Danh_Sach_Tai_Khoan_CCCD.xlsx
 * Cấu trúc  : Row 1-4 là tiêu đề/header, dữ liệu từ row 5 trở đi
 *   Col 1: STT
 *   Col 2: Họ và tên
 *   Col 3: Số CCCD (12 chữ số)
 *   Col 4: Mật khẩu mặc định
 *
 * Chạy     : node scripts/seed-teachers.js
 * Đăng nhập: Số CCCD (12 số)  |  Mật khẩu: như cột 4 (yêu cầu đổi sau lần đầu)
 */
require('dotenv').config();
const bcrypt  = require('bcryptjs');
const ExcelJS = require('exceljs');
const path    = require('path');
const { getUserModel, getConnection } = require('../db');

const EXCEL_PATH   = path.join(__dirname, 'Danh_Sach_Tai_Khoan_CCCD.xlsx');
const HEADER_ROWS  = 4; // Số dòng tiêu đề cần bỏ qua (rows 1-4)
const BATCH_SIZE   = 20;

// Danh sách 44 lớp chủ nhiệm — gán tuần tự theo thứ tự giáo viên trong Excel
const HOMEROOM_CLASSES = [
  '6A1','6A2','6A3','6A4','6A5','6A6','6A7','6A8','6A9','6A10',
  '7A1','7A2','7A3','7A4','7A5','7A6','7A7','7A8','7A9','7A10',
  '8A1','8A2','8A3','8A4','8A5','8A6','8A7','8A8','8A9','8A10','8A11','8A12','8A13','8A14',
  '9A1','9A2','9A3','9A4','9A5','9A6','9A7','9A8','9A9','9A10',
];

function gradeFromClass(cls) {
  const m = String(cls).match(/^(\d)/);
  return m ? parseInt(m[1]) : 6;
}

async function main() {
  const conn = await getConnection('students');
  const User = getUserModel(conn);
  console.log('✅  Kết nối Astra DB thành công\n');

  // ── Đọc file Excel ──────────────────────────────────
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(EXCEL_PATH);
  } catch {
    console.error('❌  Không tìm thấy file Excel tại:', EXCEL_PATH);
    process.exit(1);
  }

  const ws = wb.worksheets[0];

  // Thu thập các dòng dữ liệu hợp lệ (bỏ qua HEADER_ROWS đầu)
  const rows = [];
  ws.eachRow((row, idx) => {
    if (idx <= HEADER_ROWS) return;
    const vals = row.values.slice(1); // bỏ index 0 (ExcelJS dùng 1-based)
    const cccd     = vals[2]; // Col 3: Số CCCD
    const fullName = vals[1]; // Col 2: Họ và tên
    const password = vals[3]; // Col 4: Mật khẩu mặc định
    // Chỉ nhận dòng có đủ CCCD và họ tên
    if (cccd && fullName) rows.push({ fullName, cccd, password });
  });

  if (rows.length === 0) {
    console.error('❌  Không tìm thấy dữ liệu trong file Excel. Kiểm tra lại cấu trúc file.');
    process.exit(1);
  }

  if (rows.length !== HOMEROOM_CLASSES.length) {
    console.warn(`⚠️  Số giáo viên (${rows.length}) khác số lớp (${HOMEROOM_CLASSES.length}).`);
    console.warn(`    Chỉ ${Math.min(rows.length, HOMEROOM_CLASSES.length)} giáo viên đầu sẽ được gán lớp chủ nhiệm.`);
  }

  console.log(`📋  Tìm thấy ${rows.length} giáo viên trong Excel`);
  console.log('⏳  Đang xử lý...\n');

  let created = 0, skipped = 0, errors = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async ({ fullName, cccd, password }, batchIdx) => {
      const globalIdx = i + batchIdx;
      const className  = HOMEROOM_CLASSES[globalIdx] || null;
      const grade      = className ? gradeFromClass(className) : null;
      try {
        const cccdStr    = String(cccd).trim().replace(/\D/g, '').padStart(12, '0');
        const nameStr    = String(fullName).trim();
        const passStr    = String(password ?? '').trim();

        if (!cccdStr || cccdStr.length !== 12) {
          console.error(`  ⚠️  CCCD không hợp lệ [${nameStr}]: "${cccd}"`);
          errors++;
          return;
        }
        if (!passStr) {
          console.error(`  ⚠️  Mật khẩu trống [${nameStr}] — bỏ qua`);
          errors++;
          return;
        }

        // Kiểm tra trùng lặp theo CCCD
        const exists = await User.findOne({ cccd: cccdStr });
        if (exists) { skipped++; return; }

        const passwordHash = await bcrypt.hash(passStr, 10);
        await User.create({
          cccd:               cccdStr,
          passwordHash,
          role:               'teacher',
          fullName:           nameStr,
          className:          className,
          grade:              grade,
          mustChangePassword: true,  // Bắt buộc đổi mật khẩu sau lần đăng nhập đầu
        });
        created++;
      } catch (err) {
        errors++;
        console.error(`  ❌  Lỗi [${fullName}]:`, err.message);
      }
    }));

    const done = Math.min(i + BATCH_SIZE, rows.length);
    process.stdout.write(
      `\r  Tiến độ: ${done}/${rows.length} (✅ ${created} mới, ⏭ ${skipped} bỏ qua, ❌ ${errors} lỗi)`
    );
  }

  console.log('\n');
  console.log('═══════════════════════════════════════');
  console.log(`✅  Tạo mới   : ${created} giáo viên`);
  console.log(`⏭  Bỏ qua    : ${skipped} (CCCD đã tồn tại)`);
  console.log(`❌  Lỗi       : ${errors}`);
  console.log('═══════════════════════════════════════');
  console.log('\n📌  Cách đăng nhập:');
  console.log('    Số CCCD  : 12 số định danh (cột 3 trong file Excel)');
  console.log('    Mật khẩu : mật khẩu mặc định (cột 4 trong file Excel)');
  console.log('    ⚠️   Hệ thống sẽ yêu cầu đổi mật khẩu sau lần đăng nhập đầu tiên.');
  console.log('\n📋  Phân công lớp chủ nhiệm (theo thứ tự trong Excel):');
  rows.slice(0, Math.min(rows.length, HOMEROOM_CLASSES.length)).forEach(({ fullName }, i) => {
    console.log(`    ${String(i+1).padStart(2,'0')}. ${HOMEROOM_CLASSES[i].padEnd(5)} — ${fullName}`);
  });
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
