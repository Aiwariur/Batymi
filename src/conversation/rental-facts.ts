import { AgentAction } from "../agent/schemas";

export interface RentalFactMessage {
  role: "assistant" | "user" | string;
  content: string;
}

export interface GroundRentalFactsInput {
  currentMessage: string;
  lastAssistantQuestion?: string;
  history?: RentalFactMessage[];
  proposedActions: AgentAction[];
  primaryListingId?: string | number | null;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function numericEvidence(value: unknown, text: string): boolean {
  const number = Number(String(value).replace(",", "."));
  if (!Number.isFinite(number)) return false;
  const pattern = escapeRegExp(String(number)).replace("\\.", "[.,]");
  return new RegExp(`(^|[^\\d])${pattern}(?!\\d)`).test(text);
}

function parseCount(text: string): number | undefined {
  const match = text.match(/\d{1,3}/);
  if (match) return Number(match[0]);
  const words: Record<string, number> = {
    один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4,
    пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
    twelve: 12, одиннадцать: 11, двенадцать: 12,
  };
  const found = text.match(/\b(одиннадцать|двенадцать|одна|одно|один|две|два|три|четыре|пять|шесть|семь|восемь|девять|десять|twelve)\b/i);
  return found ? words[found[1].toLowerCase()] : undefined;
}

function availabilityFact(text: string): "available" | "reserved" | "rented" | "withdrawn" | undefined {
  // Owners commonly answer the outreach with "Да активно" (the listing is live).
  if (/^(?:да[,!\s]*)?активн[оа][.!\s]*$/i.test(text.trim())) return "available";
  if (/\b(?:ara|ukve)\b.{0,25}\b(?:sdal|gaqira)|already\s+(?:rented|let)|უკვე\s+გაქირავ|უკვე\s+დაქირავ|уже\s+(?:сдал[аи]?|сдан[ао]?|снял[аи]?|снята|снято)|арендатор(?:ы)?\s+(?:уже\s+)?есть|уже\s+занят[ао]?/i.test(text)) return "rented";
  if (/\b(?:reserved|დაჯავშნილია)\b|забронирован[ао]?|уже\s+забронировал/i.test(text)) return "reserved";
  if (/не\s+(?:буду|будем|хочу)\s+сдавать|не\s+сда[её]тся|снимать\s+с\s+аренды|сдавать\s+не\s+буду|withdrawn|აღარ\s+ქირავდება/i.test(text)) return "withdrawn";
  if (/(?:сда[её]тся|свободн[ао]?|доступн[ао]?|актуальн[ао]?|\bavailable\b|\bvacant\b|ქირავდება|თავისუფალია|ხელმისაწვდომია)/i.test(text)) return "available";
  return undefined;
}

function extractMinimumLease(text: string): number | undefined {
  if (/(?:^|[\s,.])на\s+(?:один\s+)?год(?:[\s,.]|$)/i.test(text)) return 12;
  const duration = /(?:минимальн[а-яё]*\s+(?:срок|период)|минимум|не\s+меньше|срок\s+аренд[а-яё]*|minimum\s+(?:lease|rental)|at\s+least|\blease\s+for\b|\bаренд[а-яё]*\s+на\b|\bможно\b).{0,35}/i.exec(text)?.[0] ?? "";
  const source = duration || (/\b\d+\s*(?:год|года|лет|god|year|years)\b/i.test(text) ? text : "");
  if (!source) return undefined;
  const count = parseCount(source);
  if (!count) return undefined;
  if (/год|года|лет|\byears?\b|\bgod\b/i.test(source)) return count * 12;
  if (/месяц|мес\b|\bmonths?\b|\bmonth\b|\bthve\b/i.test(source)) return count;
  return undefined;
}

function extractPrepayment(text: string): number | undefined {
  const match = /(?:предоплат\w*|аванс\w*|оплат\w*.{0,15}заранее|заранее\s+за|впер[её]д\s+за|prepay\w*|advance\s+payment|upfront).{0,35}/i.exec(text)?.[0];
  if (!match || !/(месяц|мес\b|month|თვე)/i.test(match)) return undefined;
  return parseCount(match);
}

function hasSeasonalPricing(text: string): boolean {
  return /(зим\w*.{0,50}(лет\w*)|лет\w*.{0,50}зим\w*|winter.{0,50}summer|summer.{0,50}winter|სეზონურ)/i.test(text) && /\d/.test(text);
}

function extractMonthlyPrice(text: string): number | undefined {
  if (hasSeasonalPricing(text)) return undefined;
  const match = /(?:цена|стоимость|аренда|rent|price).{0,25}?(\d{2,7})(?:[.,]00)?(?:\s*(?:\$|usd|доллар|gel|лари))?|\b(\d{2,7})(?:[.,]00)?\s*(?:\$|usd|доллар\w*|gel|лари)?\s*(?:в|за|per)\s*(?:месяц|month)/i.exec(text);
  const leaseMoney = !/депозит|залог|комисс|deposit|commission/i.test(text) &&
    /год|месяц|мес\b|god|year|month/i.test(text)
      ? /(\d{2,7})\s*\$/.exec(text)
      : null;
  const value = Number(match?.[1] ?? match?.[2] ?? leaseMoney?.[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function dealFacts(text: string, lastQuestion = ""): { window_view?: string; complex_name?: string } {
  const data: { window_view?: string; complex_name?: string } = {};
  if (/без\s+(?:жк|жилого\s+комплекс\w*)|не\s+в\s+(?:жк|комплекс\w*)|нет\s+жк|no\s+(?:residential\s+)?complex|გარეშე\s+(?:კომპლექს|ჟკ)/i.test(text)) data.complex_name = "нет ЖК";
  if (/вид\s+на\s+море|море\s+из\s+окон|окна\s+на\s+море|sea\s+view|view\s+of\s+the\s+sea|ზღვის\s+ხედი/i.test(text) ||
      /^(?:море|sea)$/i.test(text.trim()) && /вид|view|ხედი/i.test(lastQuestion)) data.window_view = "море";
  const shortName = text.trim();
  if (!data.complex_name && /жк|комплекс|residential complex|კომპლექს/i.test(lastQuestion) &&
      /^[A-Z][A-Za-z0-9 .-]{1,45}$/.test(shortName) &&
      !/^(?:yes|no|sea|sure|okay|owner|realtor)$/i.test(shortName)) data.complex_name = shortName;
  return data;
}

function explicitCommission(text: string): Partial<Record<"commission_type" | "commission_value" | "commission_payer", string>> {
  if (!/комисс|commission|საკომისიო/i.test(text)) return {};
  const result: Partial<Record<"commission_type" | "commission_value" | "commission_payer", string>> = {};
  const percent = /(?:комисс[а-яё]*.{0,25}?(\d+(?:[.,]\d+)?)\s*%|(\d+(?:[.,]\d+)?)\s*%.{0,25}?комисс[а-яё]*|commission\w*.{0,25}?(\d+(?:[.,]\d+)?)\s*%)/i.exec(text);
  if (percent) {
    result.commission_type = "percent_month";
    result.commission_value = (percent[1] ?? percent[2] ?? percent[3] ?? "").replace(",", ".");
  }
  if (/платит\s+(?:собственник|владелец)|комисси\w*.{0,35}(?:собственник|владелец)|(?:собственник|владелец).{0,35}комисси|owner\s+pays|paid\s+by\s+owner/i.test(text)) result.commission_payer = "owner";
  else if (/платит\s+арендатор|комисси\w*.{0,35}арендатор|tenant\s+pays|paid\s+by\s+tenant/i.test(text)) result.commission_payer = "tenant";
  else if (/пополам|делим\s+комисси|split\s+(?:the\s+)?commission/i.test(text)) result.commission_payer = "split";
  return result;
}

/**
 * Keep model-proposed listing writes only when the owner's words support them,
 * then add explicit facts the model omitted. Question context grounds terse answers.
 */
export function groundRentalFacts(input: GroundRentalFactsInput): AgentAction[] {
  const history = input.history ?? [];
  const ownerText = [...history.filter((entry) => entry.role === "user").map((entry) => entry.content), input.currentMessage]
    .filter(Boolean).join("\n");
  const lower = ownerText.toLowerCase();
  const current = input.currentMessage.toLowerCase();
  const lastQuestion = (input.lastAssistantQuestion ?? [...history].reverse().find((entry) => entry.role === "assistant")?.content ?? "").toLowerCase();
  const actions: AgentAction[] = [];
  const rentalById = new Map<string, Record<string, unknown>>();
  const dealById = new Map<string, Record<string, unknown>>();
  const idFor = (candidate?: string | number) => candidate ?? input.primaryListingId ?? undefined;
  const keyFor = (id?: string | number) => String(id ?? "__primary__");
  const mergeAction = (map: Map<string, Record<string, unknown>>, id: string | number | undefined, data: Record<string, unknown>) => {
    if (!Object.keys(data).length) return;
    const key = keyFor(id);
    map.set(key, { ...(map.get(key) ?? {}), ...data });
  };

  for (const action of input.proposedActions) {
    if (action.type === "update_rental_terms") {
      const data: Record<string, unknown> = { ...action.data };
      const asked = (pattern: RegExp) => pattern.test(lastQuestion);
      for (const field of ["price", "deposit_amount", "prepayment_months", "minimum_lease_months", "commission_value"] as const) {
        if (data[field] === undefined) continue;
        const termPattern: Record<string, RegExp> = {
          price: /цен|аренд|rent|price|month|თვიური|\$|usd|доллар/,
          deposit_amount: /депозит|залог|deposit/,
          prepayment_months: /предоплат|аванс|заранее|впер[её]д|prepay|advance|upfront/,
          minimum_lease_months: /минимальн|срок аренды|minimum|lease term/,
          commission_value: /комисс|commission|საკომისიო/,
        };
        const yearValue = field === "minimum_lease_months" && Number(data[field]) % 12 === 0 &&
          new RegExp(`\\b${Number(data[field]) / 12}\\s*(?:год|года|лет|god|years?)\\b`, "i").test(current);
        const numberInCurrent = numericEvidence(data[field], current);
        const fieldMentioned = termPattern[field].test(current);
        // The model handles language and transliteration. Only reject a clear
        // conflicting field, not an unfamiliar spelling such as "Minimalni".
        const namesAnotherField = /(цен|аренд|rent|price|депозит|залог|deposit|предоплат|аванс|заранее|минимальн|срок)/i.test(current);
        const relevant = numberInCurrent && (fieldMentioned || !namesAnotherField) || yearValue;
        if (!relevant) delete data[field];
      }
      if (hasSeasonalPricing(input.currentMessage)) delete data.price;
      if (data.currency !== undefined && !/\b(?:usd|eur|gel|rub|лари|доллар|евро|рубл)\b|[$€₾₽]/i.test(lower)) delete data.currency;
      if (data.availability_status !== undefined) {
        const extracted = availabilityFact(current);
        const terseYes = /^(?:да|yes|კი|დიახ|da+|daa+)[!. ,]*$/i.test(input.currentMessage.trim()) && /доступ|свобод|сда[её]тся|available|vacant|ქირავდება/i.test(lastQuestion);
        if (extracted && data.availability_status !== extracted) data.availability_status = extracted;
        else if (!extracted && /^(?:да|yes|კი|დიახ|da+)[!. ,]*$/i.test(current.trim()) && !terseYes) delete data.availability_status;
      }
      const commissionMentioned = /комисс|commission|საკომისიო/i.test(current);
      if (!commissionMentioned) {
        delete data.commission_type;
        delete data.commission_value;
        delete data.commission_payer;
        delete data.commission_notes;
      } else {
        const explicit = explicitCommission(current);
        for (const field of ["commission_type", "commission_value", "commission_payer"] as const) {
          if (data[field] !== undefined && explicit[field] !== String(data[field])) delete data[field];
        }
      }
      if (data.lease_terms_notes !== undefined && !lower.includes(String(data.lease_terms_notes).trim().toLowerCase())) delete data.lease_terms_notes;
      mergeAction(rentalById, idFor(action.listingId), data);
    } else if (action.type === "update_deal_info") {
      const evidence = dealFacts(current, lastQuestion);
      const data: Record<string, unknown> = { ...action.data };
      // Normalized text may differ from the source language/transliteration.
      // Do not demand a literal Russian substring for a semantic model value.
      for (const field of ["window_view", "complex_name"] as const) {
        if (data[field] !== undefined && evidence[field] !== undefined) data[field] = evidence[field];
      }
      mergeAction(dealById, idFor(action.listingId), data);
    } else {
      actions.push(action);
    }
  }

  const explicitRental: Record<string, unknown> = {};
  const monthlyPrice = extractMonthlyPrice(current);
  if (monthlyPrice !== undefined) explicitRental.price = monthlyPrice;
  const minLease = extractMinimumLease(current);
  if (minLease !== undefined) explicitRental.minimum_lease_months = minLease;
  const prepayment = extractPrepayment(current);
  if (prepayment !== undefined) explicitRental.prepayment_months = prepayment;
  const availability = availabilityFact(current);
  if (availability) explicitRental.availability_status = availability;
  if (hasSeasonalPricing(input.currentMessage)) explicitRental.lease_terms_notes = input.currentMessage.trim();
  Object.assign(explicitRental, explicitCommission(current));
  mergeAction(rentalById, idFor(), explicitRental);

  const explicitDeal = dealFacts(input.currentMessage, lastQuestion);
  mergeAction(dealById, idFor(), explicitDeal);

  for (const [key, data] of rentalById) {
    const listingId = key === "__primary__" ? undefined : input.primaryListingId && key === String(input.primaryListingId) ? input.primaryListingId : key;
    actions.push({ type: "update_rental_terms", ...(listingId === undefined ? {} : { listingId }), data } as AgentAction);
  }
  for (const [key, data] of dealById) {
    const listingId = key === "__primary__" ? undefined : input.primaryListingId && key === String(input.primaryListingId) ? input.primaryListingId : key;
    actions.push({ type: "update_deal_info", ...(listingId === undefined ? {} : { listingId }), data } as AgentAction);
  }
  return actions;
}
