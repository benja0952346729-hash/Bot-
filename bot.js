require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { callAI, pool } = require("./ai");
const {
  getConfig, getBoard, saveBoard,
  ensureBoardTable, initBoard,
  actionRegister, actionPayment, actionTransfer,
  actionRemove, actionWinnerBalance,
  getFreeBlocks, getUnpaidBlocks, isAllPaid,
  buildBoardText, buildRemainingText,
} = require("./board");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

console.log("🤖 Lottery Bot ጀምሯል!");
console.log("🔑 Token:", process.env.BOT_TOKEN  ? "✅" : "❌ የለም!");
console.log("🗄️  DB:",    process.env.DATABASE_URL? "✅" : "❌ የለም!");
console.log("🤖 AI:",     process.env.AI_API_KEY_1? "✅" : "❌ የለም!");

// ─── Chat State ───────────────────────────────────────────────────
const chatState = {};
function getState(chatId) {
  if (!chatState[chatId]) {
    chatState[chatId] = {
      board_msg_id:     null,
      remaining_msg_id: null,
      msg_count:        0,
      active:           false,
    };
  }
  return chatState[chatId];
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

// ─── Board Send/Update ────────────────────────────────────────────
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

// ─── Apply AI Action to Board ─────────────────────────────────────
async function applyAction(aiResult, board, cfg, chatId) {
  const { action } = aiResult;
  let reply = aiResult.reply || "";
  let boardChanged = false;

  // ── Register ──────────────────────────────────────────────────
  if (action === "register") {
    const block   = parseInt(aiResult.block);
    const name    = aiResult.name || "Guest";
    const isHalf  = !!aiResult.is_half;
    const partner = aiResult.partner || null;

    if (!block || isNaN(block)) {
      reply = reply || "ቁጥሩን እንደገና ጻፍ 🙏";
    } else {
      const res = actionRegister(board, cfg, block, name, isHalf, partner);
      if (res.ok) {
        boardChanged = true;
        // reply ሳይኖር default
        if (!reply) {
          reply = res.reason === "partner"
            ? `${res.name} አጋር ሆኖ ገባ 🙏`
            : `እሺ 🙏 ገቢ`;
        }
      } else {
        reply = res.reason === "taken"
          ? (reply || "ተቀደምክ 🙏")
          : (reply || res.reason);
      }
    }
  }

  // ── Payment ───────────────────────────────────────────────────
  else if (action === "payment") {
    const nameOrBlock = aiResult.name || aiResult.block;
    const amount      = parseInt(aiResult.amount);

    if (!nameOrBlock || !amount || isNaN(amount)) {
      reply = reply || "ስምና ብር ጻፍ 🙏";
    } else {
      const { updated, leftover } = actionPayment(board, cfg, nameOrBlock, amount);
      boardChanged = updated.length > 0;

      if (!reply) {
        if (leftover === 0) {
          reply = `${nameOrBlock} ✅ ገቢ 🙏`;
        } else if (leftover > 0) {
          reply = `${nameOrBlock} ${leftover}ብር ቀሪ ጨምር 🙏`;
        } else {
          reply = "ስሙን አልተማወቅም 🙏";
        }
      }
    }
  }

  // ── Transfer ──────────────────────────────────────────────────
  else if (action === "transfer") {
    const from = parseInt(aiResult.from_block);
    const to   = parseInt(aiResult.to_block);

    if (!from || !to || isNaN(from) || isNaN(to)) {
      reply = reply || "ከ ወዴት ቁጥሮቹን ጻፍ 🙏";
    } else {
      const res = actionTransfer(board, cfg, from, to);
      boardChanged = res.ok;
      if (!reply) {
        reply = res.ok ? `✅ Block ${from} → ${to} ተዛወረ` : res.reason;
      }
    }
  }

  // ── Remove ────────────────────────────────────────────────────
  else if (action === "remove") {
    const block = parseInt(aiResult.block);
    if (!block || isNaN(block)) {
      reply = reply || "ቁጥሩን ጻፍ 🙏";
    } else {
      actionRemove(board, cfg, block);
      boardChanged = true;
      reply = reply || `Block ${block} ተሰርዟል`;
    }
  }

  // ── Winner Balance ────────────────────────────────────────────
  else if (action === "winner") {
    const name      = aiResult.name;
    const rank      = parseInt(aiResult.winner_rank) - 1;
    const prizes    = [cfg.prize_1st, cfg.prize_2nd, cfg.prize_3rd];
    const prize     = prizes[rank] || 0;
    const sent      = parseInt(aiResult.sent_amount) || 0;

    if (name && prize > 0) {
      const { updated, removed, balance } = actionWinnerBalance(board, cfg, name, prize, sent);
      boardChanged = updated.length > 0 || removed.length > 0;
      if (!reply) {
        reply = `🏆 ${name} — Prize: ${prize}ብር | Sent: ${sent}ብር | Balance: ${balance}ብር`;
        if (updated.length) reply += `\n✅ Auto approved: ${updated.join(", ")}`;
        if (removed.length) reply += `\n❌ Removed ✅: ${removed.join(", ")}`;
      }
    } else {
      reply = reply || "Winner ስምና rank ጻፍ 🙏";
    }
  }

  // ── Info / Unknown ────────────────────────────────────────────
  else {
    // board አይቀይርም — reply ብቻ
  }

  return { reply, boardChanged };
}

// ─── Message Handler ──────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text   = (msg.text || msg.caption || "").trim();
  const userId = msg.from?.id;
  const state  = getState(chatId);

  // Private ይተው
  if (msg.chat.type === "private") return;
  if (!text) return;

  try {
    let board = await getBoard(chatId);
    const cfg = getConfig();

    // ── Admin: አዲስ ጨዋታ ─────────────────────────────────────────
    if (/^\/newgame|አዲስ\s*ጨዋታ|new\s*game/i.test(text) && await isAdmin(chatId, userId)) {
      board = initBoard();
      await saveBoard(chatId, board);
      Object.assign(getState(chatId), {
        board_msg_id: null, remaining_msg_id: null,
        msg_count: 0, active: false,
      });
      await bot.sendMessage(chatId, "🎰 አዲስ ጨዋታ ተጀምሯል! መልካም ዕድል 🙏");
      await bot.sendMessage(chatId, buildBoardText(board, cfg));
      return;
    }

    // ── Admin: Board ──────────────────────────────────────────────
    if (/^\/board$/i.test(text) && await isAdmin(chatId, userId)) {
      await bot.sendMessage(chatId, buildBoardText(board, cfg));
      return;
    }

    // ── Admin: Unpaid warning ──────────────────────────────────────
    if (/^\/unpaid$/i.test(text) && await isAdmin(chatId, userId)) {
      const unpaid = getUnpaidBlocks(board);
      if (unpaid.length === 0) {
        await bot.sendMessage(chatId, "✅ ሁሉም ከፍለዋል!");
      } else {
        await bot.sendMessage(chatId, "⚠️ ያልከፈሉ:\n" + unpaid.join("\n"));
      }
      return;
    }

    // ── Message count (active mode) ────────────────────────────────
    if (state.active) {
      state.msg_count += 1;
      await updateRemainingOnly(chatId, board, cfg);

      if (state.msg_count >= 4) {
        await sendBoardAndRemaining(chatId, board, cfg);
      }
    }

    // ── AI Call ────────────────────────────────────────────────────
    console.log(`💬 [${chatId}] "${text}"`);
    const boardText = buildBoardText(board, cfg);

    let aiResult;
    try {
      aiResult = await callAI(text, cfg, boardText);
    } catch (aiErr) {
      console.error("❌ AI Error:", aiErr.message);
      return;
    }

    // ── Apply Action ───────────────────────────────────────────────
    const { reply, boardChanged } = await applyAction(aiResult, board, cfg, chatId);

    // Board ከተቀየረ → save
    if (boardChanged) {
      await saveBoard(chatId, board);
      console.log(`💾 Board saved [${chatId}]`);
    }

    // Reply
    if (reply) {
      try {
        await bot.sendMessage(chatId, reply, { reply_to_message_id: msg.message_id });
      } catch {
        await bot.sendMessage(chatId, reply);
      }
    }

    // ── Board Triggers ─────────────────────────────────────────────
    const freeBlocks = getFreeBlocks(board);
    const remaining  = freeBlocks.length;

    // 7 ሲቀር → board + remaining ይላካል
    if (remaining === cfg.low_slots_threshold && !state.active) {
      state.active = true;
      await sendBoardAndRemaining(chatId, board, cfg);
    }

    // ሁሉም ከፍለዋል + ሞልቷል → final board
    if (isAllPaid(board) && remaining === 0) {
      await sendFinalBoard(chatId, board, cfg);
    }

  } catch (err) {
    console.error("❌ Handler error:", err.message);
  }
});

// ─── Photo Handler (Admin screenshot) ────────────────────────────
bot.on("photo", async (msg) => {
  const chatId  = msg.chat.id;
  const userId  = msg.from?.id;
  const caption = (msg.caption || "").trim();

  if (msg.chat.type === "private") return;
  if (!await isAdmin(chatId, userId)) return;

  try {
    const board   = await getBoard(chatId);
    const cfg     = getConfig();
    const prompt  = caption
      ? `Admin ፎቶ ላከ። Caption: "${caption}". Payment ወይም winner ነው?`
      : `Admin ፎቶ ላከ። ዕጣ ውጤት ወይም payment screenshot ሊሆን ይችላል።`;

    const aiResult = await callAI(prompt, cfg, buildBoardText(board, cfg));
    const { reply, boardChanged } = await applyAction(aiResult, board, cfg, chatId);

    if (boardChanged) await saveBoard(chatId, board);
    if (reply) await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Photo error:", err.message);
  }
});

// ─── Polling Error ────────────────────────────────────────────────
bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

// ─── Init ─────────────────────────────────────────────────────────
ensureBoardTable()
  .then(() => console.log("✅ DB table ready!"))
  .catch(console.error);

process.once("SIGINT",  () => bot.stopPolling());
process.once("SIGTERM", () => bot.stopPolling());
