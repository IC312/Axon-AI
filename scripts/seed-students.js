/**
 * Seed tất cả học sinh từ file Excel vào Astra DB
 * Chạy: node scripts/seed-students.js
 *
 * Login: Số CCCD (12 số)
 * Mật khẩu mặc định: Ngày sinh dạng DDMMYYYY (vd: 02/03/2014 → 02032014)
 */
require('dotenv').config();
const bcrypt  = require('bcryptjs');
const ExcelJS = require('exceljs');
const path    = require('path');
const { getUserModel, getConnection } = require('../db');

const EXCEL_PATH = path.join(__dirname, 'ds_hoc_sinh.xlsx');

function parseDob(cell) {
  if (cell instanceof Date) {
    const d = String(cell.getDate()).padStart(2, '0');
    const m = String(cell.getMonth() + 1).padStart(2, '0');
    const y = cell.getFullYear();
    return { dobStr: `${d}${m}${y}`, dobDisplay: `${d}/${m}/${y}` };
  }
  const s = String(cell).trim();
  const parts = s.split('/');
  if (parts.length === 3) {
    const dobStr = parts[0].padStart(2,'0') + parts[1].padStart(2,'0') + parts[2];
    return { dobStr, dobDisplay: s };
  }
  return { dobStr: s, dobDisplay: s };
}

async function main() {
  const conn = await getConnection('students');
  const User = getUserModel(conn);
  console.log('✅  Kết nối Astra DB thành công\n');

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(EXCEL_PATH);
  } catch {
    console.error('❌  Không tìm thấy file Excel tại:', EXCEL_PATH);
    process.exit(1);
  }

  const ws = wb.worksheets[0];
  const rows = [];
  ws.eachRow((row, idx) => {
    if (idx === 1) return;
    const vals = row.values.slice(1);
    if (vals[4]) rows.push(vals);
  });

  console.log(`📋  Tìm thấy ${rows.length} học sinh trong Excel`);
  console.log('⏳  Đang xử lý...\n');

  let created = 0, skipped = 0, errors = 0;

  const BATCH = 20; // Astra Document API rate limit thấp hơn MongoDB
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await Promise.all(batch.map(async row => {
      try {
        const [maLop, hoTen, ngaySinh, gioiTinh, cccd] = row;
        const cccdStr = String(cccd).trim().padStart(12, '0');
        const { dobStr, dobDisplay } = parseDob(ngaySinh);

        const exists = await User.findOne({ cccd: cccdStr });
        if (exists) { skipped++; return; }

        const passwordHash = await bcrypt.hash(dobStr, 10);
        await User.create({
          cccd:      cccdStr,
          passwordHash,
          role:      'student',
          fullName:  String(hoTen).trim(),
          className: String(maLop).trim().toUpperCase(),
          gender:    String(gioiTinh).trim(),
          dob:       dobDisplay,
          mustChangePassword: true,
        });
        created++;
      } catch (err) {
        errors++;
        console.error(`  ❌ Lỗi dòng [${row[1]}]:`, err.message);
      }
    }));

    const done = Math.min(i + BATCH, rows.length);
    process.stdout.write(`\r  Tiến độ: ${done}/${rows.length} (✅ ${created} mới, ⏭ ${skipped} bỏ qua, ❌ ${errors} lỗi)`);
  }

  console.log('\n');
  console.log('═══════════════════════════════════════');
  console.log(`✅  Tạo mới   : ${created} học sinh`);
  console.log(`⏭  Bỏ qua    : ${skipped} (đã tồn tại)`);
  console.log(`❌  Lỗi       : ${errors}`);
  console.log('═══════════════════════════════════════');
  console.log('\n📌  Cách đăng nhập:');
  console.log('    Số CCCD   : 12 số định danh');
  console.log('    Mật khẩu  : Ngày sinh dạng DDMMYYYY (vd: 02032014)');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
