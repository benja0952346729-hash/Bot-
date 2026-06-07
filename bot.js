require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { callAI, pool }     = require("./ai");
const {
  getConfig, getBoard, saveBoard,
  ensureBoardTable, initBoard,
  displayBoard, getUnpaidBlocks, getFreeBlocks,
} = require("./board");

const bot = new Telegraf(process.env.BOT_TOKEN);

// ─── State (memory) ───────────────────────────────────────────────
// chat_id → { board_msg_id, remaining_msg_id, msg_count, active }
const chatState = {};

function getState(chatId) {
  if (!chatState[chatId]) {
    chatState[chatId] = {
      board_msg_id:     null,
      remaining_msg_id: null,
      msg_count:        0,
      active:           false, // 7 ቁጥር አልፏል?
    };
  }
  return chatState[chatId];
}

// ─── Helpers ──────────────────────────────────────────────────────
function buildBoardHeader(cfg) {
  const spp   = cfg.slots_per_person;
  const total = cfg.slots_total;
  const users = total / spp;
  return (
    `በ ${cfg.price_full} ብር ${spp} ቁጥሮችን በተከታታይ በመያዝ እድሎን ይሞክሩ ` +
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

    // Blank line after each block
    if (i % spp === 0 && i < total) lines.push("");
  }

  lines.push("", buildBoardFooter(cfg));
  return lines.join("\n");
}

function buildRemainingText(freeBlocks, cfg, keyword = "ቀሪ") {
  const spp   = cfg.slots_per_person;
  const lines = [keyword];
  for (const b of freeBlocks) {
    const start = (b - 1) * spp + 1;
    lines.push(String(start).padStart(2, "0"));
  }
  return lines.join("\n");
}

// ─── Board + ቀሪ send/update ──────────────────────────────────────
async function sendBoardAndRemaining(ctx, chatId, board, cfg) {
  const state     = getState(chatId);
  const freeBlocks= getFreeBlocks(board);
  const keyword   = "ቀሪ";

  // ሁሉም ✅ ሆኑ?
  if (freeBlocks.length === 0) {
    const allPaid = isAllPaid(board, cfg);
    if (allPaid) {
      await sendFinalBoard(ctx, chatId, board, cfg);
      return;
    }
  }

  const boardText    = buildBoardText(board, cfg);
  const remainingText= buildRemainingText(freeBlocks, cfg, keyword);

  // አሮጌ ይሰርዝ
  if (state.board_msg_id) {
    try { await ctx.telegram.deleteMessage(chatId, state.board_msg_id); } catch {}
  }
  if (state.remaining_msg_id) {
    try { await ctx.telegram.deleteMessage(chatId, state.remaining_msg_id); } catch {}
  }

  // አዲስ ይልክ
  const bMsg = await ctx.telegram.sendMessage(chatId, boardText);
  const rMsg = await ctx.telegram.sendMessage(chatId, remainingText);

  state.board_msg_id     = bMsg.message_id;
  state.remaining_msg_id = rMsg.message_id;
  state.msg_count        = 0;
}

async function updateRemainingOnly(ctx, chatId, board, cfg) {
  const state      = getState(chatId);
  const freeBlocks = getFreeBlocks(board);
  const keyword    = "ቀሪ";

  if (state.remaining_msg_id) {
    try { await ctx.telegram.deleteMessage(chatId, state.remaining_msg_id); } catch {}
  }

  const rMsg = await ctx.telegram.sendMessage(
    chatId, buildRemainingText(freeBlocks, cfg, keyword)
  );
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

async function sendFinalBoard(ctx, chatId, board, cfg) {
  const state = getState(chatId);

  // አሮጌ ይሰርዝ
  if (state.board_msg_id) {
    try { await ctx.telegram.deleteMessage(chatId, state.board_msg_id); } catch {}
  }
  if (state.remaining_msg_id) {
    try { await ctx.telegram.deleteMessage(chatId, state.remaining_msg_id); } catch {}
  }

  // Final board — history ለዘላለም ይቆያል
  await ctx.telegram.sendMessage(chatId, buildBoardText(board, cfg));
  await ctx.telegram.sendMessage(chatId, "🎰 ዕጣ ማውጫ ሰዓት ደረሰ! መልካም ዕድል 🙏");

  // State reset
  state.board_msg_id     = null;
  state.remaining_msg_id = null;
  state.active           = false;
}

// ─── Admin Check ──────────────────────────────────────────────────
async function isAdmin(ctx) {
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return ["administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

// ─── Payment Approve ─────────────────────────────────────────────
async function approvePayment(ctx, chatId, board, cfg, name, amount) {
  const spp = cfg.slots_per_person;

  for (let i = 1; i <= cfg.slots_total; i++) {
    const slot = board.slots[i];
    if (!slot.name) continue;
    const blockStart = Math.floor((i-1)/spp)*spp + 1;
    if (i !== blockStart) continue;

    if (slot.name !== name && slot.partner !== name) continue;

    let cost = slot.is_half ? cfg.price_half : cfg.price_full;

    // ❓ reminder ካለ 200 ብቻ ይቀረዋል
    if (slot.reminder && amount >= cfg.price_half) {
      slot.paid_main = true;
      slot.reminder  = false;
      amount -= cfg.price_half;
      continue;
    }

    if (!slot.paid_main && amount >= cost) {
      slot.paid_main = true;
      amount -= cost;
    } else if (slot.partner && !slot.paid_partner && amount >= cfg.price_half) {
      slot.paid_partner = true;
      amount -= cfg.price_half;
    } else if (!slot.paid_main && amount === cfg.price_half && !slot.is_half) {
      // 200 ብቻ ከፈለ ሙሉ slot → ❓
      slot.reminder = true;
      amount = 0;
    }

    if (amount <= 0) break;
  }

  await saveBoard(chatId, board);

  // Board update
  if (getState(chatId).active) {
    await updateRemainingOnly(ctx, chatId, board, cfg);
  }

  // ሁሉም paid?
  if (isAllPaid(board, cfg)) {
    await sendFinalBoard(ctx, chatId, board, cfg);
  }
}

// ─── Winner Balance ───────────────────────────────────────────────
async function handleWinnerBalance(ctx, chatId, board, cfg, input) {
  // Input: "1=3800\n2=0\n3=400" ወይም "1=3800, 2=0, 3=400"
  const regex  = /(\d+)\s*=\s*(\d+)/g;
  let match;
  const prizes = [cfg.prize_1st, cfg.prize_2nd, cfg.prize_3rd];
  const results= [];

  while ((match = regex.exec(input)) !== null) {
    const rank  = parseInt(match[1]) - 1;
    const sent  = parseInt(match[2]);
    const prize = prizes[rank] || 0;
    const balance = prize - sent;
    results.push({ rank: rank+1, sent, prize, balance });
  }

  // Board ያስተካክል
  const spp = cfg.slots_per_person;
  for (const r of results) {
    // winner ማን እንደሆነ DB ያውቃዋል — AI ያስተናግዳዋል
    results.push(`${r.rank}ኛ: ${r.prize}ብር prize — ${r.sent}ብር ላክህ — ${r.balance}ብር balance`);
  }

  await saveBoard(chatId, board);
  return results.map(r =>
    typeof r === "string" ? r :
    `${r.rank}ኛ: prize=${r.prize} | sent=${r.sent} | balance=${r.balance}`
  ).join("\n");
}

// ─── Main Message Handler ─────────────────────────────────────────
bot.on("message", async (ctx) => {
  const chatId = ctx.chat.id;
  const msg    = ctx.message;
  const text   = msg.text || msg.caption || "";
  const state  = getState(chatId);

  // Private messages ይተው
  if (ctx.chat.type === "private") return;

  try {
    let board = await getBoard(chatId);
    const cfg = getConfig();

    // ── Admin: አዲስ game ──────────────────────────────────────────
    if (text.match(/^\/newgame|አዲስ\s*ጨዋታ|new\s*game/i) && await isAdmin(ctx)) {
      board = initBoard();
      await saveBoard(chatId, board);
      state.board_msg_id     = null;
      state.remaining_msg_id = null;
      state.msg_count        = 0;
      state.active           = false;
      await ctx.reply("🎰 አዲስ ጨዋታ ተጀምሯል! መልካም ዕድል 🙏");
      await ctx.reply(buildBoardText(board, cfg));
      return;
    }

    // ── Admin: winner balance (1=3800 2=0 3=400) ─────────────────
    if (text.match(/\d+=\d+/) && await isAdmin(ctx)) {
      const result = await handleWinnerBalance(ctx, chatId, board, cfg, text);
      await ctx.reply(result);
      return;
    }

    // ── Message count tracker ─────────────────────────────────────
    if (state.active) {
      state.msg_count += 1;

      // ቀሪ → ሁሌ 1 message ሲመጣ ይሰረዛል
      await updateRemainingOnly(ctx, chatId, board, cfg);

      // 4 messages → board ይሰረዛል
      if (state.msg_count >= 4) {
        await sendBoardAndRemaining(ctx, chatId, board, cfg);
      }
    }

    // ── AI Call ───────────────────────────────────────────────────
    const boardText = buildBoardText(board, cfg);
    const aiReply   = await callAI(text, cfg, boardText);

    if (aiReply) {
      await ctx.reply(aiReply, { reply_to_message_id: msg.message_id });
    }

    // ── Board trigger check ───────────────────────────────────────
    const freeBlocks = getFreeBlocks(board);
    const remaining  = freeBlocks.length;

    if (remaining === cfg.low_slots_threshold && !state.active) {
      state.active = true;
      await sendBoardAndRemaining(ctx, chatId, board, cfg);
    }

  } catch (err) {
    console.error("Error:", err.message);
  }
});

// ─── Photo Handler (ዕጣ ውጤት) ─────────────────────────────────────
bot.on("photo", async (ctx) => {
  const chatId = ctx.chat.id;
  const cfg    = getConfig();

  if (ctx.chat.type === "private") return;

  try {
    // Admin ብቻ
    if (!await isAdmin(ctx)) return;

    const board   = await getBoard(chatId);
    const caption = ctx.message.caption || "";

    // AI ይተረጉመዋል
    const aiReply = await callAI(
      `Admin photo ላከ። Caption: "${caption}". ዕጣ ውጤት ነው? ካለ ቁጥሮቹን አውጣ።`,
      cfg,
      buildBoardText(board, cfg)
    );

    if (aiReply) {
      await ctx.reply(aiReply);
    }

  } catch (err) {
    console.error("Photo error:", err.message);
  }
});

// ─── Start ────────────────────────────────────────────────────────
async function main() {
  try {
    await ensureBoardTable();
    console.log("🤖 Lottery Bot ጀምሯል!");
    console.log("🔑 Token:", process.env.BOT_TOKEN ? "✅ አለ" : "❌ የለም!");
    console.log("🗄️ DB:", process.env.DATABASE_URL ? "✅ አለ" : "❌ የለም!");
    console.log("🤖 AI Key:", process.env.AI_API_KEY_1 ? "✅ አለ" : "❌ የለም!");

    await bot.launch({ dropPendingUpdates: true });

    process.once("SIGINT",  () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
    process.on("uncaughtException", (err) => {
      console.error("Uncaught:", err.message);
    });
  } catch (err) {
    console.error("❌ Bot start error:", err.message);
    process.exit(1);
  }
}

main().catch(console.error);
