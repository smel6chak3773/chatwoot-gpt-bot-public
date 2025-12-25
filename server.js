import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import axios from "axios";
import state from "./state/index.js";

dotenv.config();

console.log("🚀 CHATWOOT GPT BOT — STAGE 3 (STATE READY)");

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

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ================= STATE =================
const greeted = new Set();
const handedOver = new Set();

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
  const phrases = [
    "соедини с оператором",
    "соедините с оператором",
    "соедени с оператором",
    "соеденить с оператором",
    "хочу оператора",
    "позови оператора",
    "поговорить с оператором",
    "поговорить с человеком",
    "нужен оператор",
    "нужен человек",
    "хочу менеджера",
  ];
  return phrases.some((p) => t.includes(p));
};

// ================= BOT RULES =================
const BOT_RULES = [
  {
    match: ["график", "время работы", "режим работы"],
    answer:
      "Поддержка работает ежедневно с 9:00 до 18:00 по местному времени.",
  },
  {
    match: ["нужна помощь", "помощь поддержки", "служба поддержки"],
    answer:
      "Вы можете использовать чат поддержки или запросить оператора.\n\nЕсли вам нужен живой оператор, напишите: «соедини с оператором».",
  },
];

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

async function assignConversation(conversationId) {
  if (!OPERATOR_ASSIGNEE_ID) return;
  await axios.post(
    cw(`/conversations/${conversationId}/assignments`),
    { assignee_id: OPERATOR_ASSIGNEE_ID },
    { headers }
  );
}

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  try {
    const p = req.body;
    if (p.event !== "message_created") return res.sendStatus(200);

    const conversationId = p.conversation?.id;
    if (!conversationId) return res.sendStatus(200);

    if (p.message_type !== "incoming") return res.sendStatus(200);

    const text = p.content?.trim();
    if (!text) return res.sendStatus(200);

    if (handedOver.has(conversationId)) return res.sendStatus(200);

    if (!greeted.has(conversationId)) {
      greeted.add(conversationId);
      await sendMessage(conversationId, "Здравствуйте! Чем могу помочь?");
      return res.sendStatus(200);
    }

    const normalized = normalize(text);

    for (const rule of BOT_RULES) {
      if (rule.match.some((m) => normalized.includes(m))) {
        await sendMessage(conversationId, rule.answer);
        return res.sendStatus(200);
      }
    }

    if (wantsOperator(text)) {
      handedOver.add(conversationId);
      await sendMessage(
        conversationId,
        "Передаю диалог оператору. Пожалуйста, подождите."
      );
      await assignConversation(conversationId);
      return res.sendStatus(200);
    }

    const history = state.get(conversationId);
    history.push({ role: "user", content: text });

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content:
            "Ты ИИ ассистент поддержки. Отвечай кратко и по делу, на русском языке.",
        },
        ...history.slice(-6),
      ],
    });

    const answer =
      completion.choices?.[0]?.message?.content ||
      "Пожалуйста, уточните вопрос.";

    history.push({ role: "assistant", content: answer });
    state.set(conversationId, history);

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
