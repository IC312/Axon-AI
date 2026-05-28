/**
 * Xóa conversations rác mỗi 5 phút:
 * - Conversation trống (không có tin nhắn nào)
 * - Conversation chỉ có tin user, AI chưa reply, đã tạo > 5 phút
 */
const { getConnection, getChatModels } = require('./db');

const GRADES = [6, 7, 8, 9];
const FIVE_MIN = 5 * 60 * 1000;

async function cleanupGrade(grade) {
  const conn = await getConnection(grade);
  const { Conversation, Message } = getChatModels(conn);

  const cutoff = new Date(Date.now() - FIVE_MIN).toISOString();
  const convs = await Conversation.find({});

  const toDelete = [];
  for (const conv of convs) {
    if (conv.createdAt > cutoff) continue; // còn mới, bỏ qua

    const msgs = await Message.find({ conversationId: conv._id });
    const hasAIReply = msgs.some(m => m.role === 'assistant');

    if (msgs.length === 0 || !hasAIReply) {
      toDelete.push(conv._id);
    }
  }

  for (const id of toDelete) {
    await Conversation.findOneAndDelete({ _id: id });
    await Message.deleteMany({ conversationId: id });
  }

  if (toDelete.length > 0)
    console.log(`🧹  Khối ${grade}: xóa ${toDelete.length} conversation rác`);
}

async function runCleanup() {
  for (const grade of GRADES) {
    try { await cleanupGrade(grade); } catch { /* bỏ qua lỗi từng khối */ }
  }
}

function startCleanup() {
  // Chờ 5 phút rồi mới chạy lần đầu, sau đó mỗi 5 phút
  setTimeout(() => {
    runCleanup();
    setInterval(runCleanup, FIVE_MIN);
  }, FIVE_MIN);
  console.log('🧹  Cleanup job started (mỗi 5 phút)');
}

module.exports = { startCleanup };
