require("dotenv").config();
const OpenAI = require("openai");
const { Pool } = require("pg");

// ─── PostgreSQL ───────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── API Keys (እስከ 50) ──────────────────────────────────────────
const API_KEYS = [];
for (let i = 1; i <= 50; i++) {
  const key = process.env[`AI_API_KEY_${i}`];
  if (key) API_KEYS.push(key);
}
if (API_KEYS.length === 0) throw new Error("❌ API key የለም!");

let currentKeyIndex = 0;
function getApiKey() { return API_KEYS[currentKeyIndex]; }
function rotateKey() {
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  console.log(`🔄 Key ${currentKeyIndex + 1}/${API_KEYS.length}`);
}
function getClient() {
  return new OpenAI({
    apiKey:  getApiKey(),
    baseURL: process.env.AI_BASE_URL || "https://integrate.api.nvidia.com/v1",
  });
}

// ─── Training Examples from DB ────────────────────────────────────
async function getExamples(limit = 30) {
  try {
    const result = await pool.query(`
      SELECT event_type, data
      FROM training_events
      WHERE event_type IN (
        'registration','payment','unpaid_warning',
        'winner_balance','registration_failed',
        'board_with_remaining','remaining_update',
        'late_payment','slot_removed','winner'
      )
      ORDER BY RANDOM()
      LIMIT $1
    `, [limit]);
    return result.rows;
  } catch (err) {
    console.error("DB examples error:", err.message);
    return [];
  }
}

// ─── System Prompt ────────────────────────────────────────────────
function buildSystemPrompt(examples, cfg) {
  const exText = examples
    .map(e => `[${e.event_type}]: ${JSON.stringify(e.data, null, 0)}`)
    .join("\n");

  return `አንተ የ Lottery Telegram group bot ነህ። አማርኛ እና English ተናጋሪዎችን ታስተናግዳለህ።
ሰው አማርኛ ቢጽፍ አማርኛ ትመልሳለህ። English ቢጽፍ English ትመልሳለህ።

═══ የጨዋታ ሕጎች ═══
• Slots: ${cfg.slots_total} (01-${cfg.slots_total})
• Per person: ${cfg.slots_per_person} consecutive slots
• Block 1 = slots 01-0${cfg.slots_per_person}, Block 2 = slots 0${cfg.slots_per_person+1}-${cfg.slots_per_person*2}, ...
• ሙሉ: ${cfg.price_full}ብር | ግማሽ (+): ${cfg.price_half}ብር
• 🥇 1ኛ: ${cfg.prize_1st}ብር | 🥈 2ኛ: ${cfg.prize_2nd}ብር | 🥉 3ኛ: ${cfg.prize_3rd}ብር
• Payment: CBE ${cfg.cbe_account} (${cfg.cbe_name}), Awash ${cfg.awash_account}, Dashen ${cfg.dashen_account}, Tele Birr ${cfg.tele_birr}

═══ Board Format ═══
• ባዶ slot:  01#
• ሙሉ ሰው:   01# አበበ
• ከፍሏል:   01# አበበ✅
• ግማሽ:    01# አበበ+
• አጋር አለ: 01# አበበ+አየለ
• 200 ቀሪ:  01# አበበ❓
• ተመሳሳይ ስም: አበበ 2, አበበ 3

═══ Block ↔ Slot Mapping ═══
Block number × ${cfg.slots_per_person} - (${cfg.slots_per_person}-1) = first slot
Example: block 3 → slot ${(3-1)*cfg.slots_per_person+1}

═══ Training Examples (ከ DB) ═══
${exText}

═══ አስፈላጊ መመሪያ ═══
ALWAYS respond with ONLY valid JSON. No text before or after. No markdown.

JSON format:
{
  "action": "register" | "payment" | "transfer" | "remove" | "winner" | "info" | "unknown",
  "block": <number or null>,
  "name": <string or null>,
  "is_half": <true/false>,
  "partner": <string or null>,
  "amount": <number or null>,
  "from_block": <number or null>,
  "to_block": <number or null>,
  "winner_rank": <1/2/3 or null>,
  "sent_amount": <number or null>,
  "reply": <short reply string in same language as user>
}

═══ Action Rules ═══
• "register"  — ሰው slot ሲጠይቅ (ቁጥር + ስም ወይም ቁጥር ብቻ)
• "payment"   — ብር ሲከፈል (ስም + amount ወይም screenshot caption)
• "transfer"  — slot ሲቀየር (ከ X → Y)
• "remove"    — slot ሲሰረዝ
• "winner"    — winner ሲታወቅ
• "info"      — ጥያቄ (ቀሪ slots, ዋጋ, ወዘተ)
• "unknown"   — ሌላ (ሰላምታ, ወዘተ)

═══ Reply Examples (from training) ═══
• register success: "እሺ 🙏 ገቢ" / "ቤተሰብ ገቢ 🙏" / "Done 🙏 registered"
• taken: "ተቀደምክ 🙏" / "taken 🙏"
• low slots: "እሺ ይፍጠን 🙏"
• payment ok: "አበበ ✅ ገቢ 🙏"
• payment partial: "200ብር ቀሪ ጨምር 🙏"`;
}

// ─── Parse AI JSON safely ─────────────────────────────────────────
function parseAIJson(raw) {
  try {
    // markdown fence አስወግድ
    const clean = raw
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    return JSON.parse(clean);
  } catch {
    // JSON ውስጥ ለማግኘት ሞክር
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return { action: "unknown", reply: raw.trim() };
  }
}

// ─── Main AI Call ─────────────────────────────────────────────────
async function callAI(userMessage, gameConfig, boardState = "") {
  const examples     = await getExamples(30);
  const systemPrompt = buildSystemPrompt(examples, gameConfig);
  const MODEL        = process.env.AI_MODEL || "deepseek-ai/deepseek-v3";

  const userContent = boardState
    ? `Current Board:\n${boardState}\n\nUser message: ${userMessage}`
    : `User message: ${userMessage}`;

  console.log(`🤖 AI call: model=${MODEL}, examples=${examples.length}`);

  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    try {
      const client   = getClient();
      const response = await client.chat.completions.create({
        model:       MODEL,
        messages:    [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userContent  },
        ],
        max_tokens:  256,
        temperature: 0.1,
      });

      const raw    = response.choices[0].message.content;
      const parsed = parseAIJson(raw);
      console.log(`✅ AI result:`, JSON.stringify(parsed));
      return parsed;

    } catch (err) {
      const msg = (err.message || "").toLowerCase();
      if (msg.includes("429") || msg.includes("rate limit") || msg.includes("quota")) {
        console.log(`⚠️ Rate limit — key እቀይራለሁ... (${attempt+1}/${API_KEYS.length})`);
        rotateKey();
        await new Promise(r => setTimeout(r, 1000));
      } else {
        throw err;
      }
    }
  }

  throw new Error("❌ ሁሉም keys limit ላይ ናቸው!");
}

module.exports = { callAI, pool };
