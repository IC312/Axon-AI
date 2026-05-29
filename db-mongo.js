/**
 * db-mongo.js — MongoDB connection & models (Mongoose)
 * Dùng cho tài khoản giáo viên tự đăng ký
 */
const mongoose = require('mongoose');

let _connected = false;

async function connectMongo() {
  if (_connected) return;
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      dbName: 'axon',
      serverSelectionTimeoutMS: 8000,
    });
    _connected = true;
    console.log('✅  MongoDB connected');
    await dropStudentFullNameIndex();
  } catch (err) {
    console.error('❌  MongoDB connection failed:', err.message);
    throw err;
  }
}

// ── Teacher Schema ─────────────────────────────────────
const teacherSchema = new mongoose.Schema({
  fullName:        { type: String, required: true, trim: true },
  email:           { type: String, required: true, unique: true, lowercase: true, trim: true },
  subject:         { type: String, default: '' },        // Môn dạy
  school:          { type: String, default: '' },        // Trường công tác
  passwordHash:    { type: String, required: true },
  role:            { type: String, default: 'teacher' },
  authType:        { type: String, default: 'email' },
  isVerified:      { type: Boolean, default: false },
  assignedClasses: { type: [String], default: [] },      // Lớp được phân công
  createdAt:       { type: Date, default: Date.now },
  updatedAt:       { type: Date, default: Date.now },
});

teacherSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

const Teacher = mongoose.models.Teacher || mongoose.model('Teacher', teacherSchema);

// ── Student Schema ─────────────────────────────────────
const studentSchema = new mongoose.Schema({
  fullName:           { type: String, required: true, trim: true },
  email:              { type: String, default: '', lowercase: true, trim: true },
  cccd:               { type: String, default: '', trim: true },
  username:           { type: String, default: '', trim: true },
  passwordHash:       { type: String, required: true },
  role:               { type: String, default: 'student' },
  authType:           { type: String, default: 'email' },
  className:          { type: String, default: '' },
  gender:             { type: String, default: '' },
  dob:                { type: String, default: '' },
  grade:              { type: Number, default: 9 },
  mustChangePassword: { type: Boolean, default: false },
  // ── Email verification ────────────────────────────
  emailVerified:      { type: Boolean, default: false },
  verificationOtp:    { type: String,  default: null },
  otpExpiresAt:       { type: Date,    default: null },
  createdAt:          { type: Date, default: Date.now },
  updatedAt:          { type: Date, default: Date.now },
});

studentSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

const Student = mongoose.models.Student || mongoose.model('Student', studentSchema);

// Xóa unique index fullName nếu tồn tại (migration safety)
async function dropStudentFullNameIndex() {
  try {
    await Student.collection.dropIndex('fullName_1');
  } catch (_) { /* index không tồn tại → bỏ qua */ }
}

module.exports = { connectMongo, Teacher, Student };