// Deliberately conservative: a conditional answer or a question is left to a human.
const greetings = new Set(["здравствуйте", "добрый день", "добрый вечер", "привет", "dobri den", "dobry den", "hello", "hi", "გამარჯობა"]);
const positive = new Set(["да", "ага", "да да", "конечно", "согласен", "согласна", "готов сотрудничать", "готова сотрудничать", "готовы сотрудничать", "да согласен", "да согласна", "да готов", "да готова", "da", "yes", "yeah", "დიახ", "კი"]);
const negative = new Set(["нет", "не актуальна", "неактуальна", "не сотрудничаю", "не готов сотрудничать", "не готова сотрудничать", "не хочу сотрудничать", "нет спасибо", "net", "net spasibo", "no", "no thanks", "არა"]);

export function cooperationDecision(text: string): "agreed" | "disagreed" | null {
  if (/[?？]/u.test(text)) return null;
  const parts = text.toLowerCase().replace(/ё/g, "е").replace(/[👍👌✅]/gu, " да ")
    .split(/[\n.!;,]+/u).map(part => part.replace(/\s+/g, " ").trim())
    .filter(part => part && !greetings.has(part) && !["спасибо", "spasibo", "thanks", "thank you"].includes(part));
  if (!parts.length || parts.some(part => !positive.has(part) && !negative.has(part))) return null;
  // Conflicting yes/no answers are ambiguous, even across a debounced batch.
  const yes = parts.some(part => positive.has(part));
  const no = parts.some(part => negative.has(part));
  return yes === no ? null : yes ? "agreed" : "disagreed";
}

export const COOPERATION_QUESTION = "Ваша квартира ещё актуальна? Готовы сотрудничать с нашим агентством по её сдаче в долгосрочную аренду?";
