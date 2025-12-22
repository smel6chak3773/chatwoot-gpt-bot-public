import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

dotenv.config();

console.log("🚀 CHATWOOT GPT BOT — STAGE 3 (RAG + SOFT SUPPORT HINT)");

/* ================= APP ================= */
const app = express();
app.use(express.json({ limit: "10mb" }));

/* ================= CONFIG ================= */
const PORT = Number(process.env.BOT_PORT || 5005);

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_KEY = process.env.CHATWOOT_API_KEY;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const OPERATOR_ASSIGNEE_ID = process.env.OPERATOR_ASSIGNEE_ID
  ? Number(process.env.OPERATOR_ASSIGNEE_ID)
  : null;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ================= STATE ================= */
const greeted = new Set();
const handedOver = new Set();

/* ================= UTILS ================= */
const normalize = (t) =>
  String(t || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * ❗ ТОЛЬКО ЯВНЫЙ ЗАПРОС ОПЕРАТОРА
 */
const wantsOperator = (text) => {
  const t = normalize(text);
  return (
    t.includes("соедини с оператором") ||
    t.includes("соедините с оператором") ||
    t.includes("нужен оператор") ||
    t.includes("хочу оператора") ||
    t.includes("живой оператор") ||
    t.includes("человек оператор")
  );
};

/**
 * 🟡 МЯГКИЙ НАМЁК НА ПОДДЕРЖКУ (НЕ handoff)
 */
const looksLikeSupportRequest = (text) => {
  const t = normalize(text);
  return t.includes("помощ") || t.includes("поддерж");
};

/* ================= CHATWOOT API ================= */
const cw = (p) =>
  `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}${p}`;

const headers = {
  api_access_token: CHATWOOT_API_KEY,
};

async function sendMessage(conversationId, content) {
  await axios.post(
    cw(`/conversations/${conversationId}/messages`),
    { content },
    { headers }
  );
}

async function addPrivateNote(conversationId, content) {
  await axios.post(
    cw(`/conversations/${conversationId}/messages`),
    { content, private: true },
    { headers }
  );
}

async function assignConversation(conversationId) {
  if (!OPERATOR_ASSIGNEE_ID) return;

  await axios.post(
    cw(`/conversations/${conversationId}/assignments`),
    { assignee_id: OPERATOR_ASSIGNEE_ID },
    { headers }
  );
}

/* ================= RAG: LOAD KNOWLEDGE ================= */
const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");

function loadKnowledge() {
  const files = fs.readdirSync(KNOWLEDGE_DIR);
  const chunks = [];

  for (const file of files) {
    const content = fs.readFileSync(
      path.join(KNOWLEDGE_DIR, file),
      "utf-8"
    );

    const parts = content
      .split("\n")
      .map(p => p.trim())
      .filter(p => p.length > 20);

    for (const part of parts) {
      chunks.push({
        source: file,
        text: part,
      });
    }
  }

  return chunks;
}

const KNOWLEDGE_BASE = loadKnowledge();
console.log(`📚 Загружено фрагментов базы знаний: ${KNOWLEDGE_BASE.length}`);

/* ================= RAG: RETRIEVAL ================= */
const STOP_WORDS = new Set([
  "и","в","во","на","а","но","что","как","какой","какая","какие",
  "когда","где","ли","это","по","с","у","за","от","до","или",
  "либо","же","бы","время","какое"
]);

function retrieveContext(question) {
  const words = normalize(question)
    .split(" ")
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  const scored = KNOWLEDGE_BASE.map(chunk => {
    let score = 0;
    for (const word of words) {
      if (chunk.text.toLowerCase().includes(word)) {
        score++;
      }
    }
    return { ...chunk, score };
  });

  return scored
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

/* ================= HEALTH ================= */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* ================= WEBHOOK ================= */
app.post("/webhook", async (req, res) => {
  try {
    const payload = req.body;

    if (payload.event !== "message_created") {
      return res.sendStatus(200);
    }

    const conversationId = payload.conversation?.id;
    if (!conversationId) return res.sendStatus(200);

    // анти-луп
    if (payload.message_type !== "incoming") {
      return res.sendStatus(200);
    }

    const text = payload.content?.trim();
    if (!text) return res.sendStatus(200);

    if (handedOver.has(conversationId)) {
      return res.sendStatus(200);
    }

    // приветствие
    if (!greeted.has(conversationId)) {
      greeted.add(conversationId);
      await sendMessage(conversationId, "Здравствуйте! Чем могу помочь?");
      return res.sendStatus(200);
    }

    // явный запрос оператора
    if (wantsOperator(text)) {
      handedOver.add(conversationId);
      await sendMessage(
        conversationId,
        "Передаю диалог оператору. Пожалуйста, подождите."
      );
      await addPrivateNote(
        conversationId,
        "🧑‍💼 Диалог передан оператору по запросу клиента"
      );
      await assignConversation(conversationId);
      return res.sendStatus(200);
    }

    /* ================= RAG ================= */
    const contextChunks = retrieveContext(text);

    if (contextChunks.length === 0) {
      handedOver.add(conversationId);
      await sendMessage(
        conversationId,
        "К сожалению, у меня нет информации по этому вопросу. Я передаю диалог оператору."
      );
      await addPrivateNote(
        conversationId,
        "📚 В базе знаний нет ответа — диалог передан оператору"
      );
      await assignConversation(conversationId);
      return res.sendStatus(200);
    }

    const contextText = contextChunks
      .map(c => `• ${c.text}`)
      .join("\n");

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Ты ассистент поддержки. Отвечай ТОЛЬКО на основе контекста ниже. " +
            "Если ответа нет в контексте — честно скажи, что информации нет.",
        },
        {
          role: "user",
          content:
            `Контекст:\n${contextText}\n\nВопрос пользователя:\n${text}`,
        },
      ],
    });

    let answer =
      completion.choices?.[0]?.message?.content ||
      "Извините, я не смог найти ответ.";

    // 🟡 мягкая подсказка про оператора
    if (looksLikeSupportRequest(text)) {
      answer +=
        "\n\nЕсли вам нужен живой оператор, напишите: «соедини с оператором».";
    }

    await sendMessage(conversationId, answer);
    await addPrivateNote(conversationId, "🧠 GPT ответил пользователю");

    return res.sendStatus(200);

  } catch (e) {
    console.error("❌ ERROR:", e.message);
    return res.sendStatus(500);
  }
});

/* ================= START ================= */
app.listen(PORT, () => {
  console.log(`🚀 Bot running → http://localhost:${PORT}/webhook`);
});
