/**
 * migrate-to-supabase.js
 *
 * Migrates existing user data to Supabase:
 *   1. school_users  ← Astra DB `users` collection (CCCD-based accounts)
 *   2. email_users   ← MongoDB `students` + `teachers` (email-based accounts)
 *
 * Run once: node scripts/migrate-to-supabase.js
 *
 * Prerequisites:
 *   - Supabase schema applied (scripts/supabase-schema.sql)
 *   - All env vars set: ASTRA_DB_*, MONGODB_URI, SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

'use strict';
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Astra DB (school users) ──────────────────────────────────────────────────
const { DataAPIClient } = require('@datastax/astra-db-ts');

async function migrateSchoolUsers() {
  console.log('\n[School] Connecting to Astra DB…');
  const client = new DataAPIClient(process.env.ASTRA_TOKEN);
  const db = client.db(process.env.ASTRA_ENDPOINT, {
    namespace: process.env.ASTRA_KEYSPACE || 'default_keyspace',
  });
  const col = db.collection('users');

  const cursor = col.find({});
  const docs = await cursor.toArray();
  console.log('[School] Found', docs.length, 'records in Astra DB');

  if (docs.length === 0) { console.log('[School] Nothing to migrate.'); return; }

  let inserted = 0, skipped = 0, errors = 0;
  for (const doc of docs) {
    const row = {
      id:                    doc._id        || doc.id,
      cccd:                  doc.cccd       || null,
      username:              doc.username   || null,
      full_name:             doc.fullName   || doc.full_name || '',
      password_hash:         doc.passwordHash || doc.password_hash || '',
      role:                  doc.role       || 'student',
      class_name:            doc.className  || doc.class_name || '',
      gender:                doc.gender     || '',
      dob:                   doc.dob        || '',
      must_change_password:  doc.mustChangePassword ?? doc.must_change_password ?? false,
      recovery_email:        doc.recoveryEmail || doc.recovery_email || null,
      recovery_email_verified: doc.recoveryEmailVerified ?? doc.recovery_email_verified ?? false,
      created_at:            doc.createdAt  || doc.created_at || new Date().toISOString(),
    };

    const { error } = await supabase.from('school_users').upsert(row, { onConflict: 'id' });
    if (error) {
      console.error('[School] Error inserting', row.id, ':', error.message);
      errors++;
    } else {
      inserted++;
    }
  }
  console.log(`[School] Done — inserted/updated: ${inserted}, errors: ${errors}`);
}

// ── MongoDB (email users) ────────────────────────────────────────────────────
async function migrateEmailUsers() {
  if (!process.env.MONGODB_URI) {
    console.log('\n[Email] MONGODB_URI not set — skipping email user migration.');
    return;
  }

  console.log('\n[Email] Connecting to MongoDB…');
  const mongoose = (() => { try { return require('mongoose'); } catch { return null; } })();
  if (!mongoose) {
    console.log('[Email] mongoose not installed — skipping (already removed from package.json).');
    console.log('[Email] If you need to migrate email users, temporarily add mongoose back,');
    console.log('[Email] run this script, then remove it again.');
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'axon', serverSelectionTimeoutMS: 8000 });
  console.log('[Email] Connected to MongoDB');

  const StudentSchema = new mongoose.Schema({}, { strict: false });
  const TeacherSchema = new mongoose.Schema({}, { strict: false });
  const Student = mongoose.models.Student || mongoose.model('Student', StudentSchema, 'students');
  const Teacher = mongoose.models.Teacher || mongoose.model('Teacher', TeacherSchema, 'teachers');

  const [students, teachers] = await Promise.all([
    Student.find({}).lean(),
    Teacher.find({}).lean(),
  ]);
  console.log('[Email] Found', students.length, 'students,', teachers.length, 'teachers');

  const docs = [
    ...students.map(s => ({ ...s, role: s.role || 'student' })),
    ...teachers.map(t => ({ ...t, role: t.role || 'teacher' })),
  ];

  if (docs.length === 0) { console.log('[Email] Nothing to migrate.'); await mongoose.disconnect(); return; }

  let inserted = 0, errors = 0;
  for (const doc of docs) {
    const id = String(doc._id);
    const row = {
      id,
      email:            doc.email || '',
      full_name:        doc.fullName || doc.full_name || '',
      password_hash:    doc.passwordHash || doc.password_hash || '',
      role:             doc.role || 'student',
      is_verified:      doc.isVerified ?? false,
      gender:           doc.gender || null,
      dob:              doc.dob || null,
      subject:          doc.subject || null,
      school:           doc.school || null,
      assigned_classes: doc.assignedClasses ? JSON.stringify(doc.assignedClasses) : null,
      reset_token:      null,
      reset_token_expires: null,
      created_at:       doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
    };

    const { error } = await supabase.from('email_users').upsert(row, { onConflict: 'id' });
    if (error) {
      console.error('[Email] Error inserting', id, ':', error.message);
      errors++;
    } else {
      inserted++;
    }
  }
  console.log(`[Email] Done — inserted/updated: ${inserted}, errors: ${errors}`);
  await mongoose.disconnect();
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await migrateSchoolUsers();
    await migrateEmailUsers();
    console.log('\n✅  Migration complete.');
  } catch (err) {
    console.error('\n❌  Migration failed:', err.message);
    process.exit(1);
  }
  process.exit(0);
})();
