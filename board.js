require("dotenv").config();
const { pool } = require("./ai");

// ─── Config ───────────────────────────────────────────────────────
function getConfig() {
  return {
    slots_total:          parseInt(process.env.SLOTS_TOTAL         || 100),
    slots_per_person:     parseInt(process.env.SLOTS_PER_PERSON    || 5),
    price_full:           parseInt(process.env.PRICE_FULL          || 400),
    price_half:           parseInt(process.env.PRICE_HALF          || 200),
    prize_1st:            parseInt(process.env.PRIZE_1ST           || 5000),
    prize_2nd:            parseInt(process.env.PRIZE_2ND           || 1000),
    prize_3rd:            parseInt(process.env.PRIZE_3RD           || 400),
    winners_count:        parseInt(process.env.WINNERS_COUNT       || 3),
    warning_minutes:      parseInt(process.env.WARNING_MINUTES     || 2),
    low_slots_threshold:  parseInt(process.env.LOW_SLOTS_THRESHOLD || 7),
    cbe_account:    process.env.CBE_ACCOUNT,
    cbe_name:       process.env.CBE_NAME,
    awash_account:  process.env.AWASH_ACCOUNT,
    dashen_account: process.env.DASHEN_ACCOUNT,
    tele_birr:      process.env.TELE_BIRR,
  };
}

// ─── DB ───────────────────────────────────────────────────────────
async function ensureBoardTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boards (
      chat_id    BIGINT PRIMARY KEY,
      data       JSONB,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function getBoard(chatId) {
  const res = await pool.query(
    "SELECT data FROM boards WHERE chat_id = $1", [chatId]
  );
  if (res.rows.length === 0) return initBoard();
  return res.rows[0].data;
}

async function saveBoard(chatId, board) {
  await pool.query(
    `INSERT INTO boards (chat_id, data, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (chat_id) DO UPDATE SET data = $2, updated_at = NOW()`,
    [chatId, JSON.stringify(board)]
  );
}

// ─── Init ─────────────────────────────────────────────────────────
function initBoard() {
  const cfg   = getConfig();
  const slots = {};
  for (let i = 1; i <= cfg.slots_total; i++) {
    slots[i] = {
      number:       i,
      name:         null,
      partner:      null,
      is_half:      false,
      paid_main:    false,
      paid_partner: false,
      reminder:     false,
    };
  }
  return { slots, name_count: {}, round: 1 };
}

// ─── Name resolver (ተመሳሳይ ስም → አበበ 2) ───────────────────────────
function resolveName(board, rawName) {
  const base = rawName.trim();
  if (!board.name_count) board.name_count = {};
  if (!board.name_count[base]) {
    board.name_count[base] = 1;
    return base;
  } else {
    board.name_count[base] += 1;
    return `${base} ${board.name_count[base]}`;
  }
}

// ─── Block helpers ────────────────────────────────────────────────
function getBlockStart(block, spp) {
  return (block - 1) * spp + 1;
}

function isBlockFree(board, block, spp) {
  const start = getBlockStart(block, spp);
  for (let i = 0; i < spp; i++) {
    if (board.slots[start + i]?.name) return false;
  }
  return true;
}

function isBlockHalfAvailable(board, block, spp) {
  const start = getBlockStart(block, spp);
  const slot  = board.slots[start];
  return slot?.name && slot?.is_half && !slot?.partner;
}

function totalBlocks(cfg) {
  return cfg.slots_total / cfg.slots_per_person;
}

// ─── ACTIONS ─────────────────────────────────────────────────────

// 1. Register
function actionRegister(board, cfg, block, name, isHalf, partner) {
  const spp   = cfg.slots_per_person;
  const total = totalBlocks(cfg);

  if (block < 1 || block > total) {
    return { ok: false, reason: "ቁጥር ልክ አይደለም" };
  }

  const start = getBlockStart(block, spp);

  // ግማሽ block — partner ሆኖ ሊገባ ይችላል
  if (isBlockHalfAvailable(board, block, spp)) {
    const resolvedPartner = resolveName(board, name);
    for (let i = 0; i < spp; i++) {
      board.slots[start + i].partner = resolvedPartner;
    }
    return { ok: true, reason: "partner", name: resolvedPartner };
  }

  if (!isBlockFree(board, block, spp)) {
    return { ok: false, reason: "taken" };
  }

  const resolvedName = resolveName(board, name || `Guest${block}`);
  for (let i = 0; i < spp; i++) {
    const s      = board.slots[start + i];
    s.name       = resolvedName;
    s.is_half    = !!isHalf;
    s.partner    = partner ? resolveName(board, partner) : null;
    s.paid_main  = false;
    s.paid_partner = false;
    s.reminder   = false;
  }

  return { ok: true, reason: "registered", name: resolvedName };
}

// 2. Payment — ስም ወይም block ቁጥር ቢሰጥ
function actionPayment(board, cfg, nameOrBlock, amount) {
  const spp     = cfg.slots_per_person;
  const updated = [];
  let   remaining = amount;

  for (let i = 1; i <= cfg.slots_total; i += spp) {
    const slot  = board.slots[i];
    if (!slot?.name) continue;

    // ስም match ወይም block number match
    const block = Math.ceil(i / spp);
    const nameMatch  = slot.name === nameOrBlock ||
                       slot.partner === nameOrBlock;
    const blockMatch = String(block) === String(nameOrBlock) ||
                       String(i) === String(nameOrBlock);

    if (!nameMatch && !blockMatch) continue;
    if (remaining <= 0) break;

    // ዋና ሰው ያልከፈለ
    if (!slot.paid_main) {
      const cost = slot.is_half ? cfg.price_half : cfg.price_full;
      if (remaining >= cost) {
        for (let j = 0; j < spp; j++) board.slots[i + j].paid_main = true;
        for (let j = 0; j < spp; j++) board.slots[i + j].reminder  = false;
        remaining -= cost;
        updated.push(i);
      } else if (remaining === cfg.price_half && !slot.is_half) {
        // 200 ብቻ ከፍሏል → ❓
        for (let j = 0; j < spp; j++) board.slots[i + j].reminder = true;
        remaining = 0;
      }
    }
    // አጋር ያልከፈለ
    else if (slot.partner && !slot.paid_partner) {
      if (remaining >= cfg.price_half) {
        for (let j = 0; j < spp; j++) board.slots[i + j].paid_partner = true;
        remaining -= cfg.price_half;
        updated.push(i);
      }
    }
  }

  return { updated, leftover: remaining };
}

// 3. Transfer
function actionTransfer(board, cfg, fromBlock, toBlock) {
  const spp = cfg.slots_per_person;
  if (!isBlockFree(board, toBlock, spp)) {
    return { ok: false, reason: "to block ተይዟል" };
  }

  const fromStart = getBlockStart(fromBlock, spp);
  const toStart   = getBlockStart(toBlock, spp);

  for (let i = 0; i < spp; i++) {
    const f = board.slots[fromStart + i];
    const t = board.slots[toStart   + i];
    t.name         = f.name;
    t.partner      = f.partner;
    t.is_half      = f.is_half;
    t.paid_main    = f.paid_main;
    t.paid_partner = f.paid_partner;
    t.reminder     = f.reminder;
    // ምንጩን ጽዳ
    f.name = null; f.partner = null; f.is_half = false;
    f.paid_main = false; f.paid_partner = false; f.reminder = false;
  }

  return { ok: true };
}

// 4. Remove slot
function actionRemove(board, cfg, block) {
  const spp   = cfg.slots_per_person;
  const start = getBlockStart(block, spp);
  for (let i = 0; i < spp; i++) {
    const s = board.slots[start + i];
    s.name = null; s.partner = null; s.is_half = false;
    s.paid_main = false; s.paid_partner = false; s.reminder = false;
  }
  return { ok: true };
}

// 5. Winner balance — winner ብር ሲላክ balance ያሰላል
function actionWinnerBalance(board, cfg, winnerName, prize, sentAmount) {
  const spp     = cfg.slots_per_person;
  const balance = prize - sentAmount;
  let   covered = 0;
  const updated = [];
  const removed = [];

  for (let i = 1; i <= cfg.slots_total; i += spp) {
    const slot = board.slots[i];
    if (!slot?.name) continue;
    if (slot.name !== winnerName && slot.partner !== winnerName) continue;

    const cost = slot.is_half ? cfg.price_half : cfg.price_full;

    if (covered + cost <= balance) {
      for (let j = 0; j < spp; j++) board.slots[i + j].paid_main = true;
      covered += cost;
      updated.push(i);
    } else {
      if (slot.paid_main) {
        for (let j = 0; j < spp; j++) board.slots[i + j].paid_main = false;
        removed.push(i);
      }
    }
  }

  return { updated, removed, balance };
}

// ─── Queries ──────────────────────────────────────────────────────
function getFreeBlocks(board, includeHalf = false) {
  const cfg   = getConfig();
  const spp   = cfg.slots_per_person;
  const total = totalBlocks(cfg);
  const free  = [];

  for (let b = 1; b <= total; b++) {
    if (isBlockFree(board, b, spp)) {
      free.push(b);
    } else if (includeHalf && isBlockHalfAvailable(board, b, spp)) {
      free.push(`${b}+`);
    }
  }
  return free;
}

function getUnpaidBlocks(board) {
  const cfg   = getConfig();
  const spp   = cfg.slots_per_person;
  const total = totalBlocks(cfg);
  const unpaid = [];

  for (let b = 1; b <= total; b++) {
    const start = getBlockStart(b, spp);
    const slot  = board.slots[start];
    if (!slot?.name) continue;

    const mainUnpaid    = !slot.paid_main;
    const partnerUnpaid = slot.partner && !slot.paid_partner;

    if (mainUnpaid && partnerUnpaid) {
      unpaid.push(String(start).padStart(2, "0"));
    } else if (mainUnpaid || partnerUnpaid) {
      unpaid.push(String(start).padStart(2, "0") + "+");
    }
  }
  return unpaid;
}

function isAllPaid(board) {
  const cfg = getConfig();
  const spp = cfg.slots_per_person;

  for (let i = 1; i <= cfg.slots_total; i += spp) {
    const slot = board.slots[i];
    if (!slot?.name) continue;
    if (!slot.paid_main)                    return false;
    if (slot.partner && !slot.paid_partner) return false;
    if (slot.reminder)                      return false;
  }
  return true;
}

// ─── Display ──────────────────────────────────────────────────────
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
    const bn    = typeof b === "string" ? parseInt(b) : b;
    const start = getBlockStart(bn, cfg.slots_per_person);
    const half  = typeof b === "string" && b.includes("+") ? "+" : "";
    lines.push(String(start).padStart(2, "0") + half);
  }
  return lines.join("\n");
}

module.exports = {
  getConfig,
  getBoard, saveBoard, ensureBoardTable, initBoard,
  actionRegister, actionPayment, actionTransfer,
  actionRemove, actionWinnerBalance,
  getFreeBlocks, getUnpaidBlocks, isAllPaid,
  buildBoardText, buildRemainingText,
  buildBoardHeader, buildBoardFooter,
  getBlockStart, totalBlocks,
};
