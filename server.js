import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import axios from "axios";

dotenv.config();

console.log("🚀 CHATWOOT GPT BOT — STAGE 2 FINAL + FALLBACK");

// ================= APP =================
const app = express();
app.use(express.json({ limit: "10mb" }));

// ================= CONFIG =================
const PORT = Number(process.env.BOT_PORT || 5005);

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_KEY = process.env.CHATWOOT_API_KEY;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const OPERATOR_ASSIGNEE_ID = process.env.OPERATOR_ASSIGNEE_ID
  ? Number(process.env.OPERATOR_ASSIGNEE_ID)
  : null;

const GPT_TIMEOUT = 15000;
const OPERATOR_FALLBACK_TIMEOUT = 3 * 60 * 1000; // 3 минуты

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ================= STATE =================
const memory = new Map();
const greeted = new Set();
const handedOver = new Set();
const fallbackTimers = new Map();

// ================= STATS =================
const stats = {
  totalIncoming: 0,
  greeted: 0,
  gptReplies: 0,
  operatorHandoffs: 0,
  operatorFallbacks: 0,
  handoffReasons: {
    manual: 0,
    timeout: 0,
  },
};

// ================= UTILS =================
const normalize = (t) =>
  String(t || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const wantsOperator = (text) => {
  const t = normalize(text);
  return (
    t.includes("оператор") ||
    t.includes("человек") ||
    t.includes("соед") ||
    t.includes("менеджер") ||
    t.includes("поддерж")
  );
};

// ================= CHATWOOT API =================
const cw = (path) =>
  `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}${path}`;

const headers = { api_access_token: CHATWOOT_API_KEY };

async function sendMessage(conversationId, content) {
  await axios.post(
    cw(`/conversations/${conversationId}/messages`),
    { content },
    { headers }
  );
}

async function addPrivateNote(conversationId, content) {
  try {
    await axios.post(
      cw(`/conversations/${conversationId}/messages`),
      { content, private: true },
      { headers }
    );
  } catch {}
}

async function assignConversation(conversationId) {
  if (!OPERATOR_ASSIGNEE_ID) return;

  await axios.post(
    cw(`/conversations/${conversationId}/assignments`),
    { assignee_id: OPERATOR_ASSIGNEE_ID },
    { headers }
  );
}

// ================= GPT =================
async function askGPT(messages) {
  return Promise.race([
    openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content:
            "Ты ИИ ассистент поддержки. Отвечай ТОЛЬКО на русском языке, кратко и по делу.",
        },
        ...messages,
      ],
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("GPT_TIMEOUT")), GPT_TIMEOUT)
    ),
  ]);
}

// ================= FALLBACK =================
function scheduleFallback(conversationId) {
  if (fallbackTimers.has(conversationId)) return;

  const timer = setTimeout(async () => {
    if (!handedOver.has(conversationId)) return;

    handedOver.delete(conversationId);
    fallbackTimers.delete(conversationId);
    stats.operatorFallbacks++;

    await addPrivateNote(
      conversationId,
      "🔁 Оператор не ответил — бот продолжил диалог"
    );

    await sendMessage(
      conversationId,
      "Похоже, оператор пока не подключился. Я продолжу помогать вам."
    );
  }, OPERATOR_FALLBACK_TIMEOUT);

  fallbackTimers.set(conversationId, timer);
}

function cancelFallback(conversationId) {
  if (fallbackTimers.has(conversationId)) {
    clearTimeout(fallbackTimers.get(conversationId));
    fallbackTimers.delete(conversationId);
  }
}

// ================= HEALTH =================
app.get("/health", (req, res) => res.json({ ok: true }));

// ================= STATS =================
app.get("/stats", (req, res) => res.json(stats));

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  try {
    const payload = req.body;

    if (payload.event !== "message_created") {
      return res.sendStatus(200);
    }

    const conversationId = payload.conversation?.id;
    if (!conversationId) return res.sendStatus(200);

    // 🔥 если оператор написал — отменяем fallback
    if (payload.message_type === "outgoing") {
      cancelFallback(conversationId);
      return res.sendStatus(200);
    }

    // 🔥 только сообщения клиента
    if (payload.message_type !== "incoming") {
      return res.sendStatus(200);
    }

    const text = payload.content?.trim();
    if (!text) return res.sendStatus(200);

    stats.totalIncoming++;

    // если у оператора — бот молчит
    if (handedOver.has(conversationId)) {
      return res.sendStatus(200);
    }

    // 👋 приветствие
    if (!greeted.has(conversationId) && !memory.has(conversationId)) {
      greeted.add(conversationId);
      stats.greeted++;
      await sendMessage(conversationId, "Здравствуйте! Чем могу помочь?");
      return res.sendStatus(200);
    }

    // 🧑‍💼 запрос оператора
    if (wantsOperator(text)) {
      handedOver.add(conversationId);
      stats.operatorHandoffs++;
      stats.handoffReasons.manual++;

      await addPrivateNote(
        conversationId,
        "🧑‍💼 Диалог передан оператору по запросу клиента"
      );

      await sendMessage(
        conversationId,
        "Передаю диалог оператору. Пожалуйста, подождите."
      );
      await assignConversation(conversationId);
      scheduleFallback(conversationId);
      return res.sendStatus(200);
    }

    // ===== GPT =====
    const history = memory.get(conversationId) || [];
    history.push({ role: "user", content: text });

    let answer;
    try {
      const completion = await askGPT(history.slice(-10));
      answer = completion.choices?.[0]?.message?.content;
    } catch {
      handedOver.add(conversationId);
      stats.operatorHandoffs++;
      stats.handoffReasons.timeout++;

      await addPrivateNote(
        conversationId,
        "⏱ GPT не ответил — диалог передан оператору"
      );

      await assignConversation(conversationId);
      scheduleFallback(conversationId);
      return res.sendStatus(200);
    }

    history.push({ role: "assistant", content: answer });
    memory.set(conversationId, history);

    stats.gptReplies++;

    await addPrivateNote(
      conversationId,
      "🧠 GPT ответил пользователю"
    );

    await sendMessage(conversationId, answer);
    return res.sendStatus(200);

  } catch (e) {
    console.error("❌ ERROR:", e.message);
    return res.sendStatus(500);
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`🚀 Bot running → http://localhost:${PORT}/webhook`);
});
