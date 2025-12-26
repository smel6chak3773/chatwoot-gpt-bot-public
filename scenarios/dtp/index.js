import axios from "axios";

// ================= STATIC DATA =================

const CHECKLIST = `
❗ ВАЖНО ПРИ ДТП:
— Не покидайте место происшествия
— Включите аварийную сигнализацию
— Установите знак аварийной остановки
— Сделайте фото повреждений, номеров и места ДТП
— Не подписывайте документы, если не уверены
`;

const QUESTIONS = [
  { key: "injured", text: "Есть ли пострадавшие? (да / нет)" },
  { key: "can_move", text: "Автомобиль может двигаться? (да / нет)" },
  { key: "on_road", text: "Вы на проезжей части? (да / нет)" },
];

// ================= HELPERS =================

async function sendMessage(conversationId, content, chatwootUrl, token) {
  await axios.post(
    `${chatwootUrl}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    { content },
    { headers: { api_access_token: token } }
  );
}

const normalize = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isYesNo = (text) => {
  const t = normalize(text);
  if (t.includes("да")) return "yes";
  if (t.includes("нет")) return "no";
  return null;
};

// ================= MAIN SCENARIO =================

export async function handleDtp({ message }, ctx, session) {
  const { conversationId, chatwootUrl, token, openai } = ctx;

  const text = normalize(message);

  // ===== Активация сценария (временно по ключевому слову) =====
  if (!session.scenario && text.includes("дтп")) {
    session.scenario = {
      name: "dtp",
      step: "start",
      answers: {},
      qIndex: 0,
      freeGptUsed: 0,
    };
  }

  // Если сценарий не активен — ничего не делаем
  if (!session.scenario || session.scenario.name !== "dtp") {
    return false;
  }

  const s = session.scenario;

  // ================= STEP: START =================
  if (s.step === "start") {
    s.step = "questions";

    await sendMessage(
      conversationId,
      "Я с вами. Сохраняйте спокойствие.\n\nПожалуйста, ответьте на несколько вопросов ниже, чтобы я мог помочь.\nОтвечайте: **да** или **нет**.",
      chatwootUrl,
      token
    );

    // сразу задаём первый вопрос
    await sendMessage(conversationId, QUESTIONS[0].text, chatwootUrl, token);
    return true;
  }

  // ================= STEP: QUESTIONS =================
  if (s.step === "questions") {
    const q = QUESTIONS[s.qIndex];

    // если вопросы закончились
    if (!q) {
      s.step = "checklist";
      await sendMessage(conversationId, CHECKLIST, chatwootUrl, token);
      return true;
    }

    // проверяем корректность ответа
    const yesNo = isYesNo(message);

    if (!yesNo) {
      await sendMessage(
        conversationId,
        "Пожалуйста, ответьте **да** или **нет**. Это важно, чтобы я мог правильно помочь.",
        chatwootUrl,
        token
      );
      return true;
    }

    // сохраняем ответ
    s.answers[q.key] = yesNo;
    s.qIndex++;

    // задаём следующий вопрос
    const nextQuestion = QUESTIONS[s.qIndex];
    if (nextQuestion) {
      await sendMessage(conversationId, nextQuestion.text, chatwootUrl, token);
    } else {
      s.step = "checklist";
      await sendMessage(conversationId, CHECKLIST, chatwootUrl, token);
    }

    return true;
  }

  // ================= STEP: LIMITED GPT =================
  if (s.step === "checklist") {
    if (s.freeGptUsed >= 2) {
      await sendMessage(
        conversationId,
        "Я могу продолжить сопровождение и дать подробную консультацию.\n\nПолный доступ доступен по подписке.",
        chatwootUrl,
        token
      );
      return true;
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Ты автоюрист. Дай краткий, чёткий и понятный совет при ДТП. Без воды.",
        },
        {
          role: "user",
          content: JSON.stringify(s.answers),
        },
      ],
    });

    s.freeGptUsed++;

    await sendMessage(
      conversationId,
      completion.choices[0].message.content,
      chatwootUrl,
      token
    );

    return true;
  }

  return false;
}
