const { pool } = require("./ai");
require("dotenv").config();

// ─── Game Config (ሁሌ fresh ያነባዋል) ───────────────────────────────
function getConfig() {
  return {
    slots_total:         parseInt(process.env.SLOTS_TOTAL        || 100),
    slots_per_person:    parseInt(process.env.SLOTS_PER_PERSON   || 5),
    price_full:          parseInt(process.env.PRICE_FULL         || 400),
    price_half:          parseInt(process.env.PRICE_HALF         || 200),
    prize_1st:           parseInt(process.env.PRIZE_1ST          || 5000),
    prize_2nd:           parseInt(process.env.PRIZE_2ND          || 1000),
    prize_3rd:           parseInt(process.env.PRIZE_3RD          || 400),
    winners_count:       parseInt(process.env.WINNERS_COUNT      || 3),
    warning_minutes:     parseInt(process.env.WARNING_MINUTES    || 2),
    low_slots_threshold: parseInt(process.env.LOW_SLOTS_THRESHOLD|| 7),
    cbe_account:   process.env.CBE_ACCOUNT,
    cbe_name:      process.env.CBE_NAME,
    awash_account: process.env.AWASH_ACCOUNT,
    dashen_account:process.env.DASHEN_ACCOUNT,
    tele_birr:     process.env.TELE_BIRR,
  };
}

// ─── DB: Board State ─────────────────────────────────────────────
async function getBoard(chatId) {
  const res = await pool.query(
    "SELECT data FROM boards WHERE chat_id = $1",
    [chatId]
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

async function ensureBoardTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boards (
      chat_id   BIGINT PRIMARY KEY,
      data      JSONB,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

// ─── Init Empty Board ─────────────────────────────────────────────
function initBoard() {
  const cfg    = getConfig();
  const slots  = {};
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

// ─── Display Board ────────────────────────────────────────────────
function displayBoard(board) {
  const cfg   = getConfig();
  const lines = [];

  for (let i = 1; i <= cfg.slots_total; i++) {
    const slot      = board.slots[i];
    const blockStart= Math.ceil(i / cfg.slots_per_person) * cfg.slots_per_person - cfg.slots_per_person + 1;

    if (i === blockStart && slot.name) {
      // ስም ያለው block መጀመሪያ
      let line = `${String(i).padStart(2, "0")}#`;
      const mark    = slot.paid_main    ? "✅" : "";
      const reminder= slot.reminder     ? "❓" : "";
      if (slot.partner) {
        const pmark = slot.paid_partner ? "✅" : "";
        line += ` ${slot.name}${mark}${reminder}+ ${slot.partner}${pmark}`;
      } else if (slot.is_half) {
        line += ` ${slot.name}${mark}${reminder}+`;
      } else {
        line += ` ${slot.name}${mark}${reminder}`;
      }
      lines.push(line);
    } else {
      lines.push(`${String(i).padStart(2, "0")}#`);
    }
  }

  // Payment info
  const cfg2  = getConfig();
  lines.push("");
  lines.push(`CBE ${cfg2.cbe_account} ${cfg2.cbe_name}`);
  lines.push(`አዋሽ ${cfg2.awash_account}`);
  lines.push(`ዳሽን ${cfg2.dashen_account}`);
  lines.push(`ቴሌ ብር ${cfg2.tele_birr}`);

  return lines.join("\n");
}

// ─── Get Unpaid Blocks ────────────────────────────────────────────
function getUnpaidBlocks(board) {
  const cfg    = getConfig();
  const unpaid = [];
  const seen   = new Set();

  for (let i = 1; i <= cfg.slots_total; i++) {
    const slot  = board.slots[i];
    if (!slot.name) continue;
    const block = Math.ceil(i / cfg.slots_per_person);
    if (seen.has(block)) continue;
    seen.add(block);

    const blockStart = (block - 1) * cfg.slots_per_person + 1;
    const s          = board.slots[blockStart];

    const mainUnpaid    = !s.paid_main;
    const partnerUnpaid = s.partner && !s.paid_partner;

    if (mainUnpaid && partnerUnpaid) {
      unpaid.push(`${String(blockStart).padStart(2, "0")}`);
    } else if (mainUnpaid || partnerUnpaid) {
      unpaid.push(`${String(blockStart).padStart(2, "0")}+`);
    }
  }

  return unpaid;
}

// ─── Get Free Blocks ──────────────────────────────────────────────
function getFreeBlocks(board, includeHalf = false) {
  const cfg  = getConfig();
  const free = [];
  const totalBlocks = cfg.slots_total / cfg.slots_per_person;

  for (let b = 1; b <= totalBlocks; b++) {
    const start = (b - 1) * cfg.slots_per_person + 1;
    const slot  = board.slots[start];

    if (!slot.name) {
      free.push(b);
    } else if (includeHalf && slot.is_half && !slot.partner) {
      free.push(`${b}+`);
    }
  }
  return free;
}

module.exports = {
  getConfig,
  getBoard,
  saveBoard,
  ensureBoardTable,
  initBoard,
  displayBoard,
  getUnpaidBlocks,
  getFreeBlocks,
};
