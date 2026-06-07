require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { callAI, pool } = require("./ai");
const {
  getConfig, getBoard, saveBoard,
  ensureBoardTable, initBoard,
  displayBoard, getUnpaidBlocks, getFreeBlocks,
} = require("./board");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

console.log("🤖 Lottery Bot ጀምሯል!");
console.log("🔑 Token:", process.env.BOT_TOKEN ? "✅ አለ" : "❌ የለም!");
console.log("🗄️ DB:", process.env.DATABASE_URL ? "✅ አለ" : "❌ የለም!");
console.log("🤖 AI Key:", process.env.AI_API_KEY_1 ? "✅ አለ" : "❌ የለም!");

// ─── State ───────────────────────────────────────────────────────
const chatState = {};
function getState(chatId) {
  if (!chatState[chatId]) {
    chatState[chatId] = {
      board_msg_id: null,
      remaining_msg_id: null,
      msg_count: 0,
      active: false,
    };
  }
  return chatState[chatId];
}

// ─── Board Display ────────────────────────────────────────────────
function buildBoardHeader(cfg) {
  const users = cfg.slots_total / cfg.slots_per_person;
  return (
    `በ ${cfg.price_full} ብር ${cfg.slots_per_person} ቁጥሮችን በተከታታይ በመያዝ እድሎን ይሞክሩ ` +
    `ለ ${users} ሰው ብቻ ፈጣን ዕድል መልካም ዕድል\n\n` +
    `መደብ 👉በ ${cfg.price_full} ብር \n` +
    `       👉ግማሽ ${cfg.price_half} ብር \n\n` +
    `1ኛ 🥇${cfg.prize_1st} ብር \n` +
    `2ኛ 🥈${cfg.prize_2nd}\n` +
    `3ኛ 🥉${cfg.prize_3rd}\n`
  );
}

function buildBoardFooter(cfg) {
  const lines = [];
  if (cfg.cbe_account)    lines.push(`CBE ${cfg.cbe_account} ${cfg.cbe_name || ""}`);
  if (cfg.awash_account)  lines.push(`አዋሽ  ${cfg.awash_account}`);
  if (cfg.dashen_account) lines.push(`ዳሽን  ${cfg.dashen_account}`);
  if (cfg.tele_birr)      lines.push(`ቴሌ ብር ${cfg.tele_birr}`);
  return lines.join("\n");
}

function buildBoardText(board, cfg) {
  const spp   = cfg.slots_per_person;
  const total = cfg.slots_total;
  const lines = [buildBoardHeader(cfg)];

  for (let i = 1; i <= total; i++) {
    const slot       = board.slots[i];
    const blockStart = Math.floor((i - 1) / spp) * spp + 1;

    if (i === blockStart && slot.name) {
      const mark     = slot.paid_main    ? "✅" : "";
      const reminder = slot.reminder     ? "❓" : "";
      if (slot.partner) {
        const pmark = slot.paid_partner ? "✅" : "";
        lines.push(`${String(i).padStart(2,"0")}# ${slot.name}${mark}${reminder}+ ${slot.partner}${pmark}`);
      } else if (slot.is_half) {
        lines.push(`${String(i).padStart(2,"0")}# ${slot.name}${mark}${reminder}+`);
      } else {
        lines.push(`${String(i).padStart(2,"0")}# ${slot.name}${mark}${reminder}`);
      }
    } else {
      lines.push(`${String(i).padStart(2,"0")}#`);
    }
    if (i % spp === 0 && i < total) lines.push("");
  }

  lines.push("", buildBoardFooter(cfg));
  return lines.join("\n");
}

function buildRemainingText(freeBlocks, cfg, keyword = "ቀሪ") {
  const lines = [keyword];
  for (const b of freeBlocks) {
    const start = (b - 1) * cfg.slots_per_person + 1;
    lines.push(String(start).padStart(2, "0"));
  }
  return lines.join("\n");
}

// ─── Admin Check ──────────────────────────────────────────────────
async function isAdmin(chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return ["administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

// ─── Board send/update ────────────────────────────────────────────
async function sendBoardAndRemaining(chatId, board, cfg) {
  const state      = getState(chatId);
  const freeBlocks = getFreeBlocks(board);

  // አሮጌ ይሰርዝ
  if (state.board_msg_id) {
    try { await bot.deleteMessage(chatId, state.board_msg_id); } catch {}
  }
  if (state.remaining_msg_id) {
    try { await bot.deleteMessage(chatId, state.remaining_msg_id); } catch {}
  }

  const bMsg = await bot.sendMessage(chatId, buildBoardText(board, cfg));
  const rMsg = await bot.sendMessage(chatId, buildRemainingText(freeBlocks, cfg));

  state.board_msg_id     = bMsg.message_id;
  state.remaining_msg_id = rMsg.message_id;
  state.msg_count        = 0;
}

async function updateRemainingOnly(chatId, board, cfg) {
  const state      = getState(chatId);
  const freeBlocks = getFreeBlocks(board);

  if (state.remaining_msg_id) {
    try { await bot.deleteMessage(chatId, state.remaining_msg_id); } catch {}
  }

  const rMsg = await bot.sendMessage(chatId, buildRemainingText(freeBlocks, cfg));
  state.remaining_msg_id = rMsg.message_id;
}

function isAllPaid(board, cfg) {
  const spp = cfg.slots_per_person;
  for (let i = 1; i <= cfg.slots_total; i += spp) {
    const slot = board.slots[i];
    if (!slot.name) continue;
    if (!slot.paid_main) return false;
    if (slot.partner && !slot.paid_partner) return false;
    if (slot.reminder) return false;
  }
  return true;
}

async function sendFinalBoard(chatId, board, cfg) {
  const state = getState(chatId);

  if (state.board_msg_id) {
    try { await bot.deleteMessage(chatId, state.board_msg_id); } catch {}
  }
  if (state.remaining_msg_id) {
    try { await bot.deleteMessage(chatId, state.remaining_msg_id); } catch {}
  }

  await bot.sendMessage(chatId, buildBoardText(board, cfg));
  await bot.sendMessage(chatId, "🎰 ዕጣ ማውጫ ሰዓት ደረሰ! መልካም ዕድል 🙏");

  state.board_msg_id     = null;
  state.remaining_msg_id = null;
  state.active           = false;
}

// ─── Message Handler ──────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text || msg.caption || "";
  const userId = msg.from?.id;
  const state  = getState(chatId);

  // Private messages ይተው
  if (msg.chat.type === "private") return;

  try {
    let board = await getBoard(chatId);
    const cfg = getConfig();

    // Admin: አዲስ game
    if (text.match(/^\/newgame|አዲስ\s*ጨዋታ|new\s*game/i) && await isAdmin(chatId, userId)) {
      board = initBoard();
      await saveBoard(chatId, board);
      Object.assign(getState(chatId), { board_msg_id: null, remaining_msg_id: null, msg_count: 0, active: false });
      await bot.sendMessage(chatId, "🎰 አዲስ ጨዋታ ተጀምሯል! መልካም ዕድል 🙏");
      await bot.sendMessage(chatId, buildBoardText(board, cfg));
      return;
    }

    // Admin: winner balance (1=3800 2=0 3=400)
    if (text.match(/^\d+=\d+/) && await isAdmin(chatId, userId)) {
      const regex  = /(\d+)\s*=\s*(\d+)/g;
      let match;
      const prizes = [cfg.prize_1st, cfg.prize_2nd, cfg.prize_3rd];
      const lines  = [];
      while ((match = regex.exec(text)) !== null) {
        const rank    = parseInt(match[1]) - 1;
        const sent    = parseInt(match[2]);
        const prize   = prizes[rank] || 0;
        const balance = prize - sent;
        lines.push(`${rank+1}ኛ: prize=${prize} | sent=${sent} | balance=${balance}`);
      }
      await bot.sendMessage(chatId, lines.join("\n"));
      return;
    }

    // Message count
    if (state.active) {
      state.msg_count += 1;
      await updateRemainingOnly(chatId, board, cfg);
      if (state.msg_count >= 4) {
        await sendBoardAndRemaining(chatId, board, cfg);
      }
    }

    // AI Call
    console.log(`💬 [${chatId}] ${text}`);
    const boardText = buildBoardText(board, cfg);
    
    let aiReply;
    try {
      aiReply = await callAI(text, cfg, boardText);
    } catch (aiErr) {
      console.error("❌ AI Error:", aiErr.message);
      return;
    }

    if (aiReply) {
      try {
        await bot.sendMessage(chatId, aiReply, { reply_to_message_id: msg.message_id });
      } catch (sendErr) {
        console.error("❌ Send Error:", sendErr.message);
        await bot.sendMessage(chatId, aiReply);
      }
    }

    // Board trigger
    const freeBlocks = getFreeBlocks(board);
    const remaining  = freeBlocks.length;

    if (remaining === cfg.low_slots_threshold && !state.active) {
      state.active = true;
      await sendBoardAndRemaining(chatId, board, cfg);
    }

    if (isAllPaid(board, cfg) && remaining === 0) {
      await sendFinalBoard(chatId, board, cfg);
    }

  } catch (err) {
    console.error("Error:", err.message);
  }
});

// ─── Photo Handler ────────────────────────────────────────────────
bot.on("photo", async (msg) => {
  const chatId  = msg.chat.id;
  const userId  = msg.from?.id;
  const caption = msg.caption || "";

  if (msg.chat.type === "private") return;
  if (!await isAdmin(chatId, userId)) return;

  try {
    const board   = await getBoard(chatId);
    const cfg     = getConfig();
    const aiReply = await callAI(
      `Admin photo ላከ። Caption: "${caption}". ዕጣ ውጤት ነው? ካለ ቁጥሮቹን አውጣ።`,
      cfg, buildBoardText(board, cfg)
    );
    if (aiReply) await bot.sendMessage(chatId, aiReply);
  } catch (err) {
    console.error("Photo error:", err.message);
  }
});

// ─── Error Handler ────────────────────────────────────────────────
bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

// ─── Init ─────────────────────────────────────────────────────────
ensureBoardTable().then(() => {
  console.log("✅ DB table ready!");
}).catch(console.error);

process.once("SIGINT",  () => bot.stopPolling());
process.once("SIGTERM", () => bot.stopPolling());
