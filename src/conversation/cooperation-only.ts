import { CrmInteraction } from "../crm/crm.client";
import { Listing } from "../types";

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


const apartmentQuestions = new Set([
  "какая квартира", "что за квартира", "о какой квартире речь", "о какой квартире", "про какую квартиру", "какую квартиру",
  "какая именно квартира", "какая квартира вас интересует", "какую квартиру имеете в виду", "о какой квартире вы говорите",
  "какое объявление", "что за объявление", "о каком объявлении речь", "какой адрес", "по какому адресу", "где квартира",
  "дайте ссылку", "пришлите ссылку", "отправьте ссылку", "можно ссылку", "ссылку пожалуйста",
  "скиньте ссылку", "пришлите пожалуйста ссылку", "можете прислать ссылку", "пришлите ссылку пожалуйста",
  "пришлите ссылку на объявление", "дайте ссылку на объявление", "ссылка на объявление",
  "which apartment", "what apartment", "which flat", "send the link", "send me the link",
]);

export function asksWhichApartment(text: string): boolean {
  const parts = text.toLowerCase().replace(/ё/g, "е").split(/[\n.!?？;,]+/u)
    .map(part => part.replace(/\s+/g, " ").trim()).filter(part => part && !greetings.has(part));
  return parts.length > 0 && parts.every(part => apartmentQuestions.has(part));
}

/** Old unmarked outreach is safe to identify only when exactly one listing exists. */
export function cooperationListing(rows: CrmInteraction[], listings: Listing[], instanceId: string): Listing | undefined {
  const outreach = rows.filter(row => row.instance_id === instanceId && row.direction === "outgoing" &&
    row.text.includes(COOPERATION_QUESTION) && row.notes?.startsWith("cooperation_outreach:v1:"))
    .sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true })).at(-1);
  if (outreach) return listings.find(listing => String(listing.id) === outreach.notes!.slice("cooperation_outreach:v1:".length));
  return listings.length === 1 ? listings[0] : undefined;
}

export function apartmentClarification(listing: Listing): string {
  const address = listing.address?.replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  const url = listing.url?.trim();
  const publicUrl = url && /^https?:\/\//i.test(url) ? url : undefined;
  if (!address && !publicUrl) return "";
  return [address ? `Пишу по поводу вашей квартиры по адресу: ${address}.` : "Пишу по поводу этой квартиры:",
    publicUrl ? `Объявление: ${publicUrl}` : "", "", COOPERATION_QUESTION].filter((line, index) => line || index === 2).join("\n");
}
