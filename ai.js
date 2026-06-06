const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const { Pool } = require("pg");
require("dotenv").config();

// ─── API Keys (እስከ 50) ──────────────────────────────────────────
const API_KEYS = [];
for (let i = 1; i <= 50; i++) {
  const key = process.env[`AI_API_KEY_${i}`];
  if (key) API_KEYS.push(key);
}

if (API_KEYS.length === 0) throw new Error("❌ API key የለም!");

let currentKeyIndex = 0;

function getApiKey() {
  return API_KEYS[currentKeyIndex];
}

function rotateKey() {
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  console.log(`🔄 Key ${currentKeyIndex + 1}/${API_KEYS.length} ላይ ተዛወረ`);
}

// ─── Provider Auto-Detect ────────────────────────────────────────
function detectProvider() {
  const url = (process.env.AI_BASE_URL || "").toLowerCase();
  if (url.includes("anthropic")) return "anthropic";
  if (url.includes("groq"))      return "groq";
  if (url.includes("openai"))    return "openai";
  if (url.includes("nvidia"))    return "nvidia";
  if (url.includes("together"))  return "together";
  return "openai"; // default (openai-compatible)
}

function getClient() {
  const provider = detectProvider();
  if (provider === "anthropic") {
    return new Anthropic({ apiKey: getApiKey() });
  }
  return new OpenAI({
    apiKey: getApiKey(),
    baseURL: process.env.AI_BASE_URL || "https://integrate.api.nvidia.com/v1",
  });
}

// ─── PostgreSQL (Neon) ───────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── DB Examples ─────────────────────────────────────────────────
async function getExamples(eventTypes = [], limit = 20) {
  try {
    let query  = "SELECT event_type, data FROM training_events";
    const params = [];

    if (eventTypes.length > 0) {
      const ph = eventTypes.map((_, i) => `$${i + 1}`).join(",");
      query += ` WHERE event_type IN (${ph})`;
      params.push(...eventTypes);
    }

    query += ` ORDER BY RANDOM() LIMIT ${limit}`;
    const result = await pool.query(query, params);
    return result.rows;
  } catch (err) {
    console.error("DB error:", err.message);
    return [];
  }
}

// ─── System Prompt ───────────────────────────────────────────────
function buildSystemPrompt(examples, cfg) {
  const exampleText = examples
    .map((e) => `[${e.event_type}]: ${JSON.stringify(e.data)}`)
    .join("\n");

  return `አንተ የ Lottery group bot ነህ። አማርኛ እና English ተናጋሪዎችን ታስተናግዳለህ።
ሰው አማርኛ ቢጽፍ አማርኛ ትመልሳለህ። English ቢጽፍ English ትመልሳለህ።

═══ የጨዳዋታ ሕጎች ═══
• Slots: ${cfg.slots_total} (01-${cfg.slots_total})
• Per person: ${cfg.slots_per_person} consecutive slots
• ሙሉ: ${cfg.price_full}ብር | ግማሽ: ${cfg.price_half}ብር
• 🥇 1ኛ: ${cfg.prize_1st}ብር | 🥈 2ኛ: ${cfg.prize_2nd}ብር | 🥉 3ኛ: ${cfg.prize_3rd}ብር
• Payment: CBE ${cfg.cbe_account} (${cfg.cbe_name}), Awash ${cfg.awash_account}, Dashen ${cfg.dashen_account}, Tele Birr ${cfg.tele_birr}

═══ Format Rules ═══
• ሙሉ: አበበ | ግማሽ: አበበ+ | አጋር: አበበ+አየለ
• ✅ = ከፍሏል | ❓ = 200ብር ቀሪ
• ተመሳሳይ ስም: አበበ 2, አበበ 3
• አጋር ሲወጣ: የቀረው ስም+
• Upgrade: አበበ+ → አበበ (200 ይጨምራል)
• Downgrade: አበበ → አበበ+ (200 ይመለሳል፣ payment reset)

═══ Registration Keywords ═══
• ግማሽ: + ÷ ግ ግማሽ g gm gmash half በግማሽ
• ሙሉ: ሙሉ mulu bemulu full (default)
• Global: "ሁሉንም +" → ሁሉም ግማሽ

═══ Bot Responses ═══
• ቁጥር ሲመዘገብ: "እሺ 🙏 ገቢ" / "Done 🙏 registered"
• ተይዟል: "ተቀደምክ 🙏" / "taken 🙏"
• ወደ መጨረሻ: "እሺ ይፍጠን 🙏"
• ❓ ሲኖር: 200ብር ቀሪ reminder

═══ Training Examples ═══
${exampleText}

═══ Rules ═══
1. ሁሌ DB data ላይ ተመርኩዘህ መልስ ስጥ
2. ግራ ሲያጋባ ጥያቄ ጠይቅ
3. አጭር እና ትክክለኛ መልስ
4. ✅ የክፍያ ምልክት ብቻ ነው — registration ላይ አትጠቀምበት`;
}

// ─── Main AI Call ─────────────────────────────────────────────────
async function callAI(userMessage, gameConfig, boardState = "") {
  const examples = await getExamples(
    ["registration", "payment", "unpaid_warning", "winner_balance"],
    20
  );

  const systemPrompt = buildSystemPrompt(examples, gameConfig);
  const userContent  = boardState
    ? `Current Board:\n${boardState}\n\nUser: ${userMessage}`
    : `User: ${userMessage}`;

  const provider = detectProvider();

  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    try {
      // ── Anthropic ──
      if (provider === "anthropic") {
        const client   = getClient();
        const response = await client.messages.create({
          model:      process.env.AI_MODEL || "claude-3-5-sonnet-20241022",
          max_tokens: 512,
          system:     systemPrompt,
          messages:   [{ role: "user", content: userContent }],
        });
        return response.content[0].text;
      }

      // ── OpenAI-compatible (NVIDIA, Groq, OpenAI, Together...) ──
      const client   = getClient();
      const response = await client.chat.completions.create({
        model:       process.env.AI_MODEL || "deepseek-ai/deepseek-v3",
        messages:    [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userContent  },
        ],
        max_tokens:  512,
        temperature: 0.3,
      });
      return response.choices[0].message.content;

    } catch (err) {
      const msg = (err.message || "").toLowerCase();
      if (msg.includes("429") || msg.includes("rate limit") || msg.includes("quota")) {
        console.log(`⚠️ Rate limit — key እቀይራለሁ... (${attempt + 1}/${API_KEYS.length})`);
        rotateKey();
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        throw err;
      }
    }
  }

  throw new Error("❌ ሁሉም keys limit ላይ ናቸው!");
}

module.exports = { callAI, getExamples, pool, detectProvider };
