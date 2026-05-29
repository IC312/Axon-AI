require('dotenv').config();
const { EmailUserModel, SchoolUserModel } = require('../db-supabase');

(async () => {
  try {
    const emailAll = await EmailUserModel.find({}).lean();
    const schoolAll = await SchoolUserModel.find({}).lean();

    const emailTeachers = emailAll.filter(u => u.role === 'teacher').length;
    const emailStudents = emailAll.filter(u => u.role === 'student').length;
    const emailNoClass = emailAll.filter(u => !u.className || u.className === '').length;

    const schoolTeachers = schoolAll.filter(u => u.role === 'teacher').length;
    const schoolStudents = schoolAll.filter(u => u.role === 'student').length;
    const schoolNoClass = schoolAll.filter(u => !u.className || u.className === '').length;

    console.log(JSON.stringify({
      emailCount: emailAll.length,
      emailTeachers, emailStudents, emailNoClass,
      schoolCount: schoolAll.length,
      schoolTeachers, schoolStudents, schoolNoClass
    }));
    process.exit(0);
  } catch (err) {
    console.error('ERROR', err && err.message ? err.message : err);
    process.exit(2);
  }
})();