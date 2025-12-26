import axios from "axios";

const QUESTIONS = [
  { key: "car", text: "Какая марка и модель автомобиля?" },
  { key: "problem", text: "Что произошло с машиной?" },
  { key: "can_move", text: "Автомобиль может двигаться? (да / нет)" },
];

async function sendMessage(conversationId, content, chatwootUrl, token) {
  await axios.post(
    `${chatwootUrl}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    { content },
    { headers: { api_access_token: token } }
  );
}

const normalize = (t) =>
  String(t || "").toLowerCase().replace(/ё/g, "е");

export async function handleBreakdown({ message }, ctx, session) {
  const { conversationId, chatwootUrl, token } = ctx;
  const text = normalize(message);

  if (
    !session.scenario &&
    ["поломка", "эвакуатор", "не заводится"].some((w) => text.includes(w))
  ) {
    session.scenario = {
      name: "breakdown",
      step: "questions",
      answers: {},
      qIndex: 0,
    };
    await sendMessage(
      conversationId,
      "Понял. Сейчас задам несколько вопросов.",
      chatwootUrl,
      token
    );
    await sendMessage(conversationId, QUESTIONS[0].text, chatwootUrl, token);
    return true;
  }

  if (!session.scenario || session.scenario.name !== "breakdown") return false;

  const s = session.scenario;
  const q = QUESTIONS[s.qIndex];
  if (!q) {
    await sendMessage(
      conversationId,
      "Спасибо. Сейчас подберём подходящую помощь.",
      chatwootUrl,
      token
    );
    return true;
  }

  s.answers[q.key] = message;
  s.qIndex++;

  const next = QUESTIONS[s.qIndex];
  if (next) {
    await sendMessage(conversationId, next.text, chatwootUrl, token);
  }

  return true;
}
