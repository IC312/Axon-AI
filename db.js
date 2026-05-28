const { DataAPIClient } = require('@datastax/astra-db-ts');
const { v4: uuidv4 } = require('uuid');

// ── Kết nối Astra DB (lazy — chỉ khởi tạo khi thực sự gọi) ──
let client, db;
function getDb() {
  if (!db) {
    if (!process.env.ASTRA_TOKEN || !process.env.ASTRA_ENDPOINT) {
      throw new Error('AstraDB chưa được cấu hình (ASTRA_TOKEN / ASTRA_ENDPOINT chưa set)');
    }
    client = new DataAPIClient(process.env.ASTRA_TOKEN);
    db = client.db(process.env.ASTRA_ENDPOINT, {
      keyspace: process.env.ASTRA_KEYSPACE,
    });
  }
  return db;
}

// Cache collections đã khởi tạo
const _collections = {};
const _pending = {};

async function getCollection(name, createOptions = {}) {
  if (_collections[name]) return _collections[name];
  if (_pending[name]) return _pending[name];

  _pending[name] = (async () => {
    const d = getDb();
    try {
      await d.createCollection(name, createOptions);
    } catch (e) {
      // Bỏ qua lỗi "already exists"
      if (!String(e.message).includes('already exist')) throw e;
    }
    const col = d.collection(name);
    _collections[name] = col;
    console.log(`✅  Collection [${name}] ready`);
    return col;
  })();

  return _pending[name];
}

function now() { return new Date().toISOString(); }

// ══════════════════════════════════════════════════════
// USER MODEL
// ══════════════════════════════════════════════════════
async function getUserCollection() {
  return getCollection('users');
}

function docToUser(doc) {
  return {
    ...doc,
    id: doc._id,
    save: async function () {
      const col = await getUserCollection();
      const { save, id, ...rest } = this;
      await col.replaceOne({ _id: this._id }, { ...rest, updatedAt: now() });
    },
  };
}

const UserModel = {
  async findOne(query) {
    const col = await getUserCollection();
    if (query.$or) {
      for (const cond of query.$or) {
        const doc = await col.findOne(cond);
        if (doc) return docToUser(doc);
      }
      return null;
    }
    const doc = await col.findOne(query);
    return doc ? docToUser(doc) : null;
  },

  async findById(id) {
    const col = await getUserCollection();
    const doc = await col.findOne({ _id: String(id) });
    return doc ? docToUser(doc) : null;
  },

  async create(data) {
    const col = await getUserCollection();
    const ts = now();
    const doc = { _id: uuidv4(), ...data, createdAt: ts, updatedAt: ts };
    await col.insertOne(doc);
    return docToUser(doc);
  },

  // Admin: find many with optional filter, returns chainable with .select().lean()
  find(query = {}) {
    const self = this;
    const p = (async () => {
      const col = await getUserCollection();
      const filter = {};
      for (const [k, v] of Object.entries(query)) {
        if (v && typeof v === 'object' && '$ne' in v) {
          // skip $ne filter — AstraDB doesn't support it; filter client-side
          filter[k] = undefined;
        } else {
          filter[k] = v;
        }
      }
      // Remove undefined keys
      Object.keys(filter).forEach(k => filter[k] === undefined && delete filter[k]);
      const cursor = col.find(Object.keys(filter).length ? filter : {}, { limit: 10000 });
      let docs = await cursor.toArray();
      // Apply client-side $ne filters
      for (const [k, v] of Object.entries(query)) {
        if (v && typeof v === 'object' && '$ne' in v) {
          docs = docs.filter(d => d[k] !== v['$ne']);
        }
      }
      if (query.role) docs = docs.filter(d => d.role === query.role);
      return docs.map(docToUser);
    })();
    const chain = {
      select: () => chain,
      lean: () => p,
      sort: () => chain,
      then: (res, rej) => p.then(res, rej),
    };
    return chain;
  },

  async countDocuments(query = {}) {
    const col = await getUserCollection();
    const docs = await col.find(query, { limit: 10000 }).toArray();
    return docs.length;
  },
};

// ══════════════════════════════════════════════════════
// CHAT MODELS (Conversation + Message per grade)
// ══════════════════════════════════════════════════════
function convCollName(grade) { return `conversations_${grade}`; }
function msgCollName(grade)  { return `messages_${grade}`; }

function toStr(v) {
  if (!v) return v;
  if (typeof v === 'object' && v.toString) return v.toString();
  return String(v);
}

function buildFilter(query) {
  const f = {};
  for (const [k, v] of Object.entries(query)) {
    f[k] = toStr(v);
  }
  return f;
}

function getChatModels(grade) {
  const Conversation = {
    async create(data) {
      const col = await getCollection(convCollName(grade));
      const ts = now();
      const doc = {
        _id: uuidv4(),
        userId: toStr(data.userId),
        title: data.title || 'Hội thoại mới',
        createdAt: ts,
        updatedAt: ts,
      };
      await col.insertOne(doc);
      return doc;
    },

    async find(query) {
      const col = await getCollection(convCollName(grade));
      const cursor = col.find(buildFilter(query), { sort: { updatedAt: -1 }, limit: 500 });
      const docs = await cursor.toArray();
      const result = {
        lean: () => docs,
        sort: () => result,
        then: (res, rej) => Promise.resolve(docs).then(res, rej),
      };
      return result;
    },

    async findOne(query) {
      const col = await getCollection(convCollName(grade));
      return col.findOne(buildFilter(query));
    },

    async findById(id) {
      const col = await getCollection(convCollName(grade));
      return col.findOne({ _id: String(id) });
    },

    async findOneAndUpdate(query, update, opts = {}) {
      const col = await getCollection(convCollName(grade));
      return col.findOneAndUpdate(
        buildFilter(query),
        { $set: { ...update, updatedAt: now() } },
        { returnDocument: opts.new ? 'after' : 'before' }
      );
    },

    async findOneAndDelete(query) {
      const col = await getCollection(convCollName(grade));
      return col.findOneAndDelete(buildFilter(query));
    },

    async findByIdAndUpdate(id, update) {
      const col = await getCollection(convCollName(grade));
      await col.updateOne({ _id: String(id) }, { $set: { ...update, updatedAt: now() } });
    },

    async countDocuments(query = {}) {
      const col = await getCollection(convCollName(grade));
      const docs = await col.find(Object.keys(query).length ? buildFilter(query) : {}, { limit: 10000 }).toArray();
      return docs.length;
    },

    async distinct(field, query = {}) {
      const col = await getCollection(convCollName(grade));
      const docs = await col.find(Object.keys(query).length ? buildFilter(query) : {}, { limit: 10000 }).toArray();
      return [...new Set(docs.map(d => d[field]).filter(Boolean))];
    },
  };

  const Message = {
    async create(data) {
      const col = await getCollection(msgCollName(grade));
      const ts = now();
      const doc = {
        _id: uuidv4(),
        conversationId: toStr(data.conversationId),
        role: data.role,
        content: data.content,
        createdAt: ts,
        updatedAt: ts,
      };
      await col.insertOne(doc);
      return doc;
    },

    async find(query) {
      const col = await getCollection(msgCollName(grade));
      const cursor = col.find(buildFilter(query), { sort: { createdAt: 1 }, limit: 1000 });
      const docs = await cursor.toArray();
      const result = {
        lean: () => docs,
        sort: () => result,
        then: (res, rej) => Promise.resolve(docs).then(res, rej),
      };
      return result;
    },

    async countDocuments(query = {}) {
      const col = await getCollection(msgCollName(grade));
      // Handle $in operator for conversationId
      if (query.conversationId && typeof query.conversationId === 'object' && '$in' in query.conversationId) {
        const ids = query.conversationId['$in'].map(String);
        if (!ids.length) return 0;
        let total = 0;
        // Batch in groups of 10
        for (let i = 0; i < ids.length; i += 10) {
          const batch = ids.slice(i, i + 10);
          const docs = await col.find({ conversationId: { $in: batch } }, { limit: 10000 }).toArray();
          total += docs.length;
        }
        return total;
      }
      const docs = await col.find(Object.keys(query).length ? buildFilter(query) : {}, { limit: 10000 }).toArray();
      return docs.length;
    },

    async deleteMany(query) {
      const col = await getCollection(msgCollName(grade));
      await col.deleteMany(buildFilter(query));
    },
  };

  return { Conversation, Message };
}

// ══════════════════════════════════════════════════════
// FEEDBACK MODEL (ẩn danh)
// ══════════════════════════════════════════════════════
async function getFeedbackCollection() {
  return getCollection('feedback');
}

const FeedbackModel = {
  async create(data) {
    const col = await getFeedbackCollection();
    const ts = now();
    const doc = {
      _id: uuidv4(),
      userId: data.userId || null,   // lưu để học sinh xem lại; admin không hiển thị tên
      content: data.content,
      adminReply: null,
      repliedAt: null,
      adminRead: false,    // admin đã xem chưa
      studentRead: false,  // học sinh đã xem phản hồi chưa
      createdAt: ts,
    };
    await col.insertOne(doc);
    return doc;
  },

  async find() {
    const col = await getFeedbackCollection();
    const cursor = col.find({}, { sort: { createdAt: -1 }, limit: 500 });
    return cursor.toArray();
  },

  async findByUser(userId) {
    const col = await getFeedbackCollection();
    const cursor = col.find({ userId: String(userId) }, { sort: { createdAt: -1 }, limit: 200 });
    return cursor.toArray();
  },

  async countDocuments() {
    const col = await getFeedbackCollection();
    const docs = await col.find({}, { limit: 5000 }).toArray();
    return docs.length;
  },

  async deleteById(id) {
    const col = await getFeedbackCollection();
    await col.deleteOne({ _id: String(id) });
  },

  async reply(id, replyText) {
    const col = await getFeedbackCollection();
    await col.updateOne(
      { _id: String(id) },
      { $set: { adminReply: replyText, repliedAt: now(), studentRead: false } }
    );
  },

  async markAdminRead(ids) {
    // Đánh dấu admin đã xem — ids là mảng hoặc 'all'
    const col = await getFeedbackCollection();
    if (ids === 'all') {
      const docs = await col.find({ adminRead: false }, { limit: 1000 }).toArray();
      for (const d of docs) await col.updateOne({ _id: d._id }, { $set: { adminRead: true } });
    } else {
      for (const id of ids) await col.updateOne({ _id: String(id) }, { $set: { adminRead: true } });
    }
  },

  async markStudentRead(userId) {
    // Đánh dấu học sinh đã xem phản hồi — tất cả góp ý có adminReply chưa đọc
    const col = await getFeedbackCollection();
    const docs = await col.find({ userId: String(userId), adminReply: { $ne: null }, studentRead: false }, { limit: 200 }).toArray();
    for (const d of docs) await col.updateOne({ _id: d._id }, { $set: { studentRead: true } });
    return docs.length; // số lượng vừa đánh dấu
  },

  async markStudentReadOne(id, userId) {
    // Đánh dấu học sinh đã xem một góp ý cụ thể
    const col = await getFeedbackCollection();
    await col.updateOne({ _id: String(id), userId: String(userId) }, { $set: { studentRead: true } });
  },
};

// ── API tương thích với routes cũ ────────────────────
async function getConnection(key) {
  return { grade: key, readyState: 1 };
}

function getUserModel(_conn) {
  return UserModel;
}

// Xóa cache collection để buộc tái kết nối (dùng khi gặp "session has been destroyed")
function clearCollectionCache(...names) {
  const targets = names.length ? names : Object.keys(_collections);
  for (const n of targets) {
    delete _collections[n];
    delete _pending[n];
  }
}

// routes/chat.js gọi getChatModels(conn) với conn = { grade }
module.exports = {
  getConnection,
  getChatModels: (conn) => getChatModels(conn.grade),
  getUserModel,
  FeedbackModel,
  getCollection,
  clearCollectionCache,
};
