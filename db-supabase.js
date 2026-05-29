'use strict';
/**
 * db-supabase.js — Supabase client + user models
 *
 * SchoolUserModel : tài khoản trường (CCCD-based auth), thay thế Astra DB users + UserModel
 * EmailUserModel  : tài khoản email ngoài (học sinh + giáo viên tự đăng ký), thay thế MongoDB
 *
 * Cả hai model đều dùng service role key để bypass RLS.
 * KHÔNG bao giờ expose SUPABASE_SERVICE_KEY ra client/browser.
 */

const { createClient } = require('@supabase/supabase-js');

let _supabase = null;

function getClient() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY chưa được cấu hình.');
    }
    _supabase = createClient(url, key, {
      auth: { persistSession: false },
    });
  }
  return _supabase;
}

function now() { return new Date().toISOString(); }

// Supabase PostgREST giới hạn 1000 hàng/request — helper này paginate qua tất cả trang
async function _fetchAll(buildQuery, wrap) {
  const PAGE = 1000;
  let from = 0;
  let all = [];
  while (true) {
    const { data, error } = await buildQuery(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all = all.concat((data || []).map(wrap));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ══════════════════════════════════════════════════════════════
// SCHOOL USER MODEL — table: school_users
// Dùng cho tài khoản trường (CCCD, username — bcrypt + JWT)
// ══════════════════════════════════════════════════════════════

function wrapSchoolUser(row) {
  if (!row) return null;
  return {
    ...row,
    _id:                   row.id,
    // camelCase aliases for route handlers
    fullName:              row.full_name,
    passwordHash:          row.password_hash,
    className:             row.class_name,
    mustChangePassword:    row.must_change_password,
    recoveryEmail:         row.recovery_email,
    recoveryEmailVerified: row.recovery_email_verified,
    recoveryOtp:           row.recovery_otp,
    recoveryOtpExpiresAt:  row.recovery_otp_expires_at ? new Date(row.recovery_otp_expires_at) : null,
    createdAt:             row.created_at,
    updatedAt:             row.updated_at,
    assignedClasses:       row.assigned_classes || [],
    // Explicit save() — maps camelCase back to snake_case columns
    save: async function () {
      const sb = getClient();
      const patch = {
        full_name:               this.fullName,
        password_hash:           this.passwordHash,
        class_name:              this.className             || '',
        grade:                   this.grade                 ?? 9,
        gender:                  this.gender                || '',
        dob:                     this.dob                   || '',
        must_change_password:    this.mustChangePassword    ?? false,
        recovery_email:          this.recoveryEmail         ?? null,
        recovery_email_verified: this.recoveryEmailVerified ?? false,
        recovery_otp:            this.recoveryOtp           ?? null,
        recovery_otp_expires_at: this.recoveryOtpExpiresAt
          ? (this.recoveryOtpExpiresAt instanceof Date ? this.recoveryOtpExpiresAt.toISOString() : this.recoveryOtpExpiresAt)
          : null,
        username:                this.username              ?? null,
        assigned_classes:        Array.isArray(this.assignedClasses) ? this.assignedClasses : [],
        updated_at:              now(),
      };
      const { error } = await sb.from('school_users').update(patch).eq('id', this.id);
      if (error) throw new Error(error.message);
    },
    deleteOne: async function () {
      const sb = getClient();
      const { error } = await sb.from('school_users').delete().eq('id', this.id);
      if (error) throw new Error(error.message);
    },
  };
}

const SchoolUserModel = {
  async findOne(query) {
    const sb = getClient();
    let q = sb.from('school_users').select('*');

    // Handle $or (used in CCCD login: { $or: [{ cccd }, { username: cccd }, { email: cccd }] })
    if (query.$or) {
      const filters = query.$or
        .map(cond => {
          const [k, v] = Object.entries(cond)[0];
          return `${k}.eq.${v}`;
        })
        .join(',');
      q = q.or(filters);
    } else {
      for (const [k, v] of Object.entries(query)) {
        if (v === null || v === undefined) {
          q = q.is(k, null);
        } else if (typeof v === 'object' && '$ne' in v) {
          q = q.neq(k, v.$ne);
        } else {
          q = q.eq(k, v);
        }
      }
    }

    const { data, error } = await q.limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    return wrapSchoolUser(data);
  },

  async findById(id) {
    const sb = getClient();
    const { data, error } = await sb
      .from('school_users')
      .select('*')
      .eq('id', String(id))
      .maybeSingle();
    if (error) throw new Error(error.message);
    return wrapSchoolUser(data);
  },

  async create(data) {
    const sb = getClient();
    const ts = now();
    const row = {
      full_name:            data.fullName,
      cccd:                 data.cccd      || null,
      username:             data.username  || null,
      password_hash:        data.passwordHash,
      role:                 data.role      || 'student',
      class_name:           data.className || '',
      grade:                data.grade     ?? 9,
      gender:               data.gender    || '',
      dob:                  data.dob       || '',
      must_change_password: data.mustChangePassword ?? false,
      recovery_email:            null,
      recovery_email_verified:   false,
      recovery_otp:              null,
      recovery_otp_expires_at:   null,
      created_at: ts,
      updated_at: ts,
    };
    const { data: inserted, error } = await sb
      .from('school_users')
      .insert(row)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return wrapSchoolUser(inserted);
  },

  // Trả về chainable object đồng bộ (giống Mongoose Query) — fetch chạy khi await/.lean()
  find(query = {}) {
    const sb = getClient();

    // Build danh sách filter để truyền vào mỗi trang
    const filters = [];
    for (const [k, v] of Object.entries(query)) {
      const col = _fieldMap(k);
      if (!col) continue;
      filters.push({ col, v });
    }

    const fetchPromise = _fetchAll((from, to) => {
      let q = sb.from('school_users').select('*').range(from, to);
      for (const { col, v } of filters) {
        if (v === null || v === undefined) q = q.is(col, null);
        else if (typeof v === 'object' && '$ne' in v) q = q.neq(col, v.$ne);
        else if (typeof v === 'object' && '$in' in v) q = q.in(col, v.$in);
        else q = q.eq(col, v);
      }
      return q;
    }, wrapSchoolUser);

    const result = {
      lean:   () => fetchPromise,
      sort:   () => result,
      select: () => result,
      then:   (res, rej) => fetchPromise.then(res, rej),
    };
    return result;
  },

  async countDocuments(query = {}) {
    const rows = await this.find(query).lean();
    return rows.length;
  },

  async findByIdAndUpdate(id, update) {
    const sb = getClient();
    const mapped = {};
    for (const [k, v] of Object.entries(update)) {
      const col = _fieldMap(k);
      if (col) mapped[col] = v;
      else mapped[k] = v;
    }
    mapped.updated_at = now();
    const { error } = await sb
      .from('school_users')
      .update(mapped)
      .eq('id', String(id));
    if (error) throw new Error(error.message);
  },

  async deleteById(id) {
    const sb = getClient();
    const { error } = await sb.from('school_users').delete().eq('id', String(id));
    if (error) throw new Error(error.message);
  },
};

// Map camelCase field names → snake_case column names
function _fieldMap(field) {
  const map = {
    fullName:              'full_name',
    passwordHash:          'password_hash',
    className:             'class_name',
    mustChangePassword:    'must_change_password',
    recoveryEmail:         'recovery_email',
    recoveryEmailVerified: 'recovery_email_verified',
    recoveryOtp:           'recovery_otp',
    recoveryOtpExpiresAt:  'recovery_otp_expires_at',
    assignedClasses:       'assigned_classes',
    createdAt:             'created_at',
    updatedAt:             'updated_at',
  };
  return map[field] || field;
}

// ══════════════════════════════════════════════════════════════
// EMAIL USER MODEL — table: email_users
// Dùng cho tài khoản ngoài (email-based — học sinh + giáo viên tự đăng ký)
// ══════════════════════════════════════════════════════════════

function wrapEmailUser(row) {
  if (!row) return null;
  return {
    ...row,
    _id:      row.id,
    fullName: row.full_name,
    passwordHash:      row.password_hash,
    className:         row.class_name,
    mustChangePassword: row.must_change_password,
    emailVerified:     row.email_verified,
    verificationOtp:   row.verification_otp,
    otpExpiresAt:      row.otp_expires_at ? new Date(row.otp_expires_at) : null,
    resetToken:        row.reset_token,
    resetTokenExpiresAt: row.reset_token_expires_at ? new Date(row.reset_token_expires_at) : null,
    schoolName:        row.school_name,
    authType:          'email',
    save: async function () {
      const sb = getClient();
      const patch = {
        full_name:            this.fullName,
        password_hash:        this.passwordHash,
        email_verified:       this.emailVerified,
        verification_otp:     this.verificationOtp    ?? null,
        otp_expires_at:       this.otpExpiresAt       ? this.otpExpiresAt.toISOString() : null,
        reset_token:          this.resetToken         ?? null,
        reset_token_expires_at: this.resetTokenExpiresAt ? this.resetTokenExpiresAt.toISOString() : null,
        must_change_password: this.mustChangePassword ?? false,
        class_name:           this.className          || '',
        grade:                this.grade              ?? 9,
        gender:               this.gender             || '',
        dob:                  this.dob                || '',
        subject:              this.subject            || '',
        school_name:          this.schoolName         || '',
        updated_at:           now(),
      };
      const { error } = await sb.from('email_users').update(patch).eq('id', this.id);
      if (error) throw new Error(error.message);
    },
    deleteOne: async function () {
      const sb = getClient();
      const { error } = await sb.from('email_users').delete().eq('id', this.id);
      if (error) throw new Error(error.message);
    },
  };
}

const EmailUserModel = {
  async findOne(query) {
    const sb = getClient();
    let q = sb.from('email_users').select('*');

    for (const [k, v] of Object.entries(query)) {
      const col = _emailFieldMap(k);
      if (v === null || v === undefined) {
        q = q.is(col, null);
      } else {
        q = q.eq(col, v);
      }
    }

    const { data, error } = await q.limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    return wrapEmailUser(data);
  },

  async findByEmail(email) {
    return this.findOne({ email: String(email).toLowerCase() });
  },

  async findById(id) {
    const sb = getClient();
    const { data, error } = await sb
      .from('email_users')
      .select('*')
      .eq('id', String(id))
      .maybeSingle();
    if (error) throw new Error(error.message);
    return wrapEmailUser(data);
  },

  async create(data) {
    const sb = getClient();
    const ts = now();
    const row = {
      full_name:        data.fullName,
      email:            String(data.email).toLowerCase(),
      password_hash:    data.passwordHash,
      role:             data.role      || 'student',
      class_name:       data.className || '',
      grade:            data.grade     ?? 9,
      gender:           data.gender    || '',
      dob:              data.dob       || '',
      subject:          data.subject   || '',
      school_name:      data.school    || data.schoolName || '',
      email_verified:   data.emailVerified   ?? false,
      verification_otp: data.verificationOtp ?? null,
      otp_expires_at:   data.otpExpiresAt    ? new Date(data.otpExpiresAt).toISOString() : null,
      reset_token:          null,
      reset_token_expires_at: null,
      must_change_password: data.mustChangePassword ?? false,
      created_at: ts,
      updated_at: ts,
    };
    const { data: inserted, error } = await sb
      .from('email_users')
      .insert(row)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return wrapEmailUser(inserted);
  },

  // Trả về chainable object đồng bộ (giống Mongoose Query) — fetch chạy khi await/.lean()
  find(query = {}) {
    const sb = getClient();

    const filters = [];
    for (const [k, v] of Object.entries(query)) {
      const col = _emailFieldMap(k);
      filters.push({ col, v });
    }

    const fetchPromise = _fetchAll((from, to) => {
      let q = sb.from('email_users').select('*').range(from, to);
      for (const { col, v } of filters) {
        if (v === null || v === undefined) q = q.is(col, null);
        else if (typeof v === 'object' && '$ne' in v) q = q.neq(col, v.$ne);
        else if (typeof v === 'object' && '$in' in v) q = q.in(col, v.$in);
        else q = q.eq(col, v);
      }
      return q;
    }, wrapEmailUser);

    const result = {
      lean:   () => fetchPromise,
      sort:   () => result,
      select: (fields) => {
        if (typeof fields === 'string' && fields.includes('-passwordHash')) {
          const stripped = fetchPromise.then(rows =>
            rows.map(r => { const { passwordHash, password_hash, ...rest } = r; return rest; })
          );
          return {
            lean: () => stripped,
            sort: () => result,
            then: (res, rej) => stripped.then(res, rej),
          };
        }
        return result;
      },
      then: (res, rej) => fetchPromise.then(res, rej),
    };
    return result;
  },

  async countDocuments(query = {}) {
    const rows = await this.find(query).lean();
    return rows.length;
  },
};

function _emailFieldMap(field) {
  const map = {
    fullName:      'full_name',
    passwordHash:  'password_hash',
    className:     'class_name',
    emailVerified: 'email_verified',
    verificationOtp: 'verification_otp',
    otpExpiresAt:  'otp_expires_at',
    resetToken:    'reset_token',
    resetTokenExpiresAt: 'reset_token_expires_at',
    mustChangePassword: 'must_change_password',
    schoolName:    'school_name',
    authType:      null, // computed, not stored
    createdAt:     'created_at',
    updatedAt:     'updated_at',
  };
  if (field in map) return map[field];
  return field;
}

module.exports = { SchoolUserModel, EmailUserModel, getClient };
