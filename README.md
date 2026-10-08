# Batymi — движок ответов собственникам (долгосрочная аренда)

Небольшой backend на TypeScript, который заменяет n8n-агентов
арендной CRM SS.GE-Rent (`n8n/N8N_AGENT_PROMPT.md` + `n8n/N8N_AGENT_AGREED_PROMPT.md`)
— обработка входящих WhatsApp-сообщений собственников (GreenAPI + CRM + LLM).

Обслуживает несколько GreenAPI instances / WhatsApp-номеров одним процессом,
собирает быстрые сообщения пользователя в один batch, обогащает их данными из
CRM, делает structured LLM call, выполняет разрешённые CRM-действия и
передаёт их результаты модели для финального текста (без записей — один вызов), затем
отправляет короткий ответ.

**Режим аренды `full`:** движок квалифицирует собственников долгосрочной
аренды — фаза 1 (`new/sent/delivered/read → agreed`) и фаза 2 (`agreed →
qualified`, сбор арендных условий конкретного Listing). Ответы отправляются
только через CRM `/api/chat/reply`, входящие вебхуки прозрачным прокси
форвардятся в CRM — CRM остаётся источником правды по interactions.

Для временного handoff доступен `OWNER_DIALOGUE_MODE=cooperation_only`.
Если адрес известен, точное первое сообщение без имени — одна фраза приветствия,
пустая строка и вопрос:
`Здравствуйте! Пишу по поводу вашей квартиры по адресу: {address}.\n\nВаша
квартира ещё актуальна? Готовы сотрудничать с нашим агентством по её сдаче в
долгосрочную аренду?`. Старое приветствие повторно не добавляется. Если адрес
пуст, CRM отправляет прежний `COOPERATION_MESSAGE` без изменений. Исходящий Interaction содержит маркер
`cooperation_outreach:v1:<listing_id>` в `notes`.

Batymi не вызывает LLM и не собирает условия аренды. На вопрос «какая
квартира/что за квартира/какой адрес/пришлите ссылку» он отвечает только по
объекту из маркера: сохранённый адрес и/или внешняя `Listing.url` только при
`http(s)`, затем повтор вопроса о сотрудничестве. Внутренняя ссылка CRM
собственнику не отправляется. Без маркера уточнение возможно только при ровно
одном доступном объекте; если исходный объект неизвестен или нет ни адреса, ни
безопасной внешней ссылки, отвечает менеджер. Уточняющее сообщение использует
общий durable outbound intent и повторно проверяет ручной takeover перед
отправкой.

Только однозначные короткие текстовые «да»/«нет» на русском, транслите,
английском или грузинском переводят контакт в `agreed`/`disagreed` без ответа
собственнику; оба статуса терминальны. Статус меняется только если последнее
исходящее содержит точный `COOPERATION_QUESTION` и исходный Listing определён
маркером или ровно одним доступным объявлением. Старые availability-only
обращения остаются ручными. Согласие вызывает частное Telegram-
уведомление от CRM. Вопросы о комиссии/условиях, составные или неоднозначные
сообщения, аудио и изображения остаются менеджеру.

Выставь `OWNER_DIALOGUE_MODE` явно при локальном запуске: код по умолчанию —
`full`, а два Coolify Compose-файла ветки handoff задают `cooperation_only`.
CRM хранит маркер `cooperation_handoff:v1`, чтобы повтор вебхука не отправлял
дублирующее уведомление. Для pending/failed/неопределённой доставки нужна
ручная сверка. При откате в `full` согласованные контакты могут снова попасть
в сбор условий; сохраняй историю и ответственного менеджера, а если контакт
должен остаться ручным — оставь `agreed` среди `TERMINAL_CRM_STATUSES`.

---

## Rent mode — как движок встроен в арендную CRM

```text
GreenAPI ──► Batymi /webhooks/greenapi/:id ──► прокси сырого вебхука ──► CRM /api/greenapi/webhook/<id>
                    │                                            (interactions, delivery-статусы, has_reply)
                    ▼
              Redis pending buffer → debounce → BullMQ → conversation lock
                    │
                    ▼
        CRM Listing + последние Interaction того же WhatsApp-инстанса
                    │
                    ▼
              LLM план (JSON: reply + actions)
                    │
              проверка записи → CRM → LLM с результатами → финальный ответ
                    │
        ┌───────────┼──────────────────────────────┐
        ▼           ▼                              ▼
  /api/status/set  /api/contacts/<phone>/deal   /api/chat/reply
  (agreed/qualified/disagreed)  + /rental-terms  (ответ с «того же» инстанса)
```

### Фазы диалога (по `crm_status` контакта)

| Фаза | Статусы CRM | Промпт | Разрешённые действия |
| --- | --- | --- | --- |
| primary | `new/sent/delivered/read` | Один общий короткий prompt | scoped CRM-actions, включая qualified при всех фактах и согласии этого хода |
| agreed | `agreed` | Тот же prompt, фактическая история и CRM | запись названных фактов, qualified при обязательном минимуме |
| qualified | `qualified` | LLM не вызывается | новые входящие сохраняет прокси CRM; отправки и действия отсутствуют |
| terminal | `disagreed/archived/no_whatsapp`, `contact_type=realtor` | — | LLM не вызывается, ответ не отправляется |

### Детерминированные гейты (`src/agent/gates.ts`)

Правила диалогового агента, проверяемые кодом до любого вызова CRM:

- статусы `new/sent/delivered/read/sold/archived/no_whatsapp/listing_removed`
  движок никогда не выставляет (в т.ч. `sent`, который в CRM шлёт сообщение);
- при переводе в `agreed` начинается сбор недостающих условий аренды;
- `qualified` — только при owner, согласии (включая этот ход) и обязательном минимуме
  для завершения разговора, отдельно от публикации (цена/валюта/`month`/доступность/
  мин. срок), включая поля, которые LLM пишет этими же действиями.
  Комиссия, window_view, ЖК и кадастровый номер
  в гейт НЕ входят: диалог не должен упираться в один неназванный ответ —
  недостающее агент фиксирует в `agent_notes`, остальное доденет менеджер;
- каждая запись объектных условий адресуется проверенным `listingId`; при >1
  активном листинге отсутствие ID запрещается (для одного листинга гейт
  подставляет его единственный проверенный ID перед вызовом CRM);
- пустые строки отбрасываются — контракт «"" = не перезаписывать» соблюдается
  автоматически; неизвестные `listingId` отклоняются;
- дедупликация против CRM-состояния: записи, значение которых совпадает
  с текущим (числа сравниваются численно, `900 === "900.00"`), отбрасываются
  целиком (`no_changes_vs_crm`) или по полям; повторный `set_contact_type`
  с тем же типом отклоняется (`unchanged_contact_type`) — LLM, пересылающий
  один и тот же пакет условий каждый ход, больше не шумит в CRM;
- ЖК назначается только точным матчингом по каталогу `GET /api/complexes`
  (маркеры «нет ЖК» id не получают).
- действия проверяются по строгой схеме и адресации; текст и смысловые факты
  не дополняются кодом. Невалидный формат/план получает один ограниченный повтор
  с конкретной ошибкой, затем quarantine без отправки и неподтверждённых записей.
- переход Batymi в `agreed` или `qualified` передаёт в CRM `suppress_telegram=true`, чтобы
  включённая legacy-настройка `telegram_on_agree` не публиковала объявление до
  завершения фазы 2; без этого поля legacy CRM сохраняет старое поведение.

### Разделение труда с CRM

В CRM остаются: первая рассылка (WA broadcast), listing-checker, авто-архивация,
Telegram-публикация, поиск/статистика и универсальный агент Hermes. Batymi —
только входящие ответы и квалификация.

---

## Быстрый старт (mock mode, без внешних credentials)

```bash
cp .env.example .env
docker compose up --build
```

После запуска в логах должно быть:

```text
Redis connected
BullMQ worker started
GreenAPI instances loaded   (instances: 5)
API started
Application ready
```

Проверка:

```bash
curl http://localhost:3000/health/ready
# {"ok":true,"redis":"ok","queue":"ok","worker":"ok","instances":5}
```

Smoke-тест (в другом терминале, пока приложение запущено):

```bash
npm run smoke
```

```text
✓ API reachable
✓ Redis connected
✓ webhook accepted
✓ message buffered
✓ debounce fired
✓ worker processed conversation
✓ CRM contact updated
✓ outgoing message generated

SMOKE TEST PASSED
```

---

## Как это работает

```text
GreenAPI instances ──► POST /webhooks/greenapi/:instanceId
                              │ auth + validate + idempotency (idMessage)
                              │ + durable proxy job в CRM
                              ▼
                        Redis pending buffer
                              │ debounce (MESSAGE_DEBOUNCE_MS)
                              ▼
                           BullMQ job
                              │ conversation lock
                              ▼
                    CRM context + chat history
                              ▼
                         LLM (structured JSON)
                        ↙                    ↘
                  CRM actions              reply
                  (Zod + gates)       CRM /api/chat/reply
```

- **Webhook делает минимум работы**: auth, валидация, idempotency, буфер и
  подтверждение постановки proxy-job. Он не ждёт CRM/LLM/транскрипцию или
  отправку WhatsApp; proxy-worker повторяет доставку в CRM.
- **Один LLM call на batch** (не автономный agent loop). LLM возвращает
  `{ reply, actions, stopConversation }`, backend сам выполняет actions.
- **Conversation key = `{instanceId}:{chatId}`** — один и тот же контакт на
  разных номерах не смешивается.
- **Distributed lock** на conversationKey с TTL, owner-token и refresh.
- **Debounce**: каждое сообщение добавляет в pending-список и переставляет
  debounce-token; устаревшие отложенные jobs пропускаются, обрабатывается
  только последний. Сообщения, пришедшие во время обработки, попадают в
  следующий batch и не теряются.

### Соответствие n8n-агентам арендной CRM

| n8n | Batymi |
| --- | --- |
| GREENAPI Trigger (обе фазы) | `POST /webhooks/greenapi/:instanceId` + normalizer + прокси в CRM |
| Redis counter/timestamp/wait/pop | `buffer/` (debounce через BullMQ + Redis token) |
| Get flat by phone (`/flat/by-phone`) | `crm.client.getListingsByPhone` (+ `rental_terms`) |
| Check manager (`== 2`) | `assigned_manager_is_ai` из CRM (менеджер с `is_ai`) / `ALLOWED_MANAGER_IDS` (легаси) / `managerId` на instance |
| N8N_AGENT_PROMPT (фаза 1, gpt-4o-mini) | `system-prompt.ts` → primary-фаза |
| N8N_AGENT_AGREED_PROMPT (фаза 2) | `system-prompt.ts` → agreed-фаза |
| tools (get_flat/set_status/set_type/update_deal/list_complexes) | 4 structured-действия + гейты + матчинг ЖК в коде |
| Send Reply | `POST /api/chat/reply` (CRM сам пишет interaction и выбирает инстанс) |
| — (новое) | qualified безусловно терминален, даже при переопределении env |

Изменения относительно n8n: **риелтор → `set_contact_type=realtor` и остановка
квалификации**; **`qualified`-диалоги терминальны** — новые сообщения сохраняются
в CRM, но Batymi молчит; **`set_crm_status=sent` невозможен в принципе**
(гейт; в CRM этот статус шлёт реальное WhatsApp-сообщение).

---

## Переменные окружения

Полный список — в `.env.example`. Ключевые:

### Redis

```env
REDIS_URL=redis://redis:6379   # внутри docker compose
REDIS_URL=redis://localhost:6379  # локально
```

### GreenAPI instances

Batymi только **принимает** вебхуки и проксирует их в CRM; отправка ответов
идёт через CRM `/api/chat/reply`. Токены инстансов не нужны — только `id`
(и опциональный `managerId`):

```env
# Вариант A: JSON-массив (рекомендуется)
GREENAPI_INSTANCES=[{"id":"7107577616","managerId":2}]

# Вариант B: нумерованные переменные
GREENAPI_INSTANCE_1_ID=
GREENAPI_INSTANCE_1_MANAGER_ID=
```

В real mode входящий webhook принимается только с токеном GreenAPI
`webhookUrlToken`: по умолчанию это заголовок `Authorization: Bearer <secret>`.
Это соответствует [документации GreenAPI по webhookUrlToken](https://green-api.com/en/docs/api/receiving/technology-webhook-endpoint/).
Задайте секрет и, при необходимости, имя заголовка:

```env
GREENAPI_WEBHOOK_SECRET=change-me
GREENAPI_WEBHOOK_SECRET_HEADER=authorization
```

Batymi forwards the same value to the CRM as
`Authorization: Bearer <secret>`; configure the Flask CRM receiver with the
identical `GREENAPI_WEBHOOK_SECRET` value. `CRM_API_KEY` remains the normal
CRM API credential. A custom inbound header changes only what Batymi accepts
from GreenAPI; the Batymi-to-CRM header stays Bearer-compatible.

В production и при `MOCK_GREENAPI=false` пустой секрет блокирует webhook и
делает `/health/ready` неготовым. Групповые чаты (`@g.us`) и payload с другим
`instanceData.idInstance` отклоняются до буфера и proxy.

### CRM (арендная CRM SS.GE-Rent)

```env
CRM_BASE_URL=https://admin.batumi-key.homes/api
CRM_API_KEY=            # N8N_API_KEY этой CRM (X-API-Key)
# Агент обслуживает диалоги, где ответственный — AI-менеджер (Manager.is_ai,
# флаг assigned_manager_is_ai от CRM). ALLOWED_MANAGER_IDS — легаси-fallback
# для старой CRM без флага (пусто = все менеджеры).
ALLOWED_MANAGER_IDS=
TERMINAL_CRM_STATUSES=qualified,disagreed,archived,no_whatsapp
```

### LLM (OpenAI-совместимый)

```env
LLM_PROVIDER=openai
LLM_MODEL=gpt-4.1
LLM_API_KEY=
LLM_BASE_URL=https://api.openai.com/v1
TRANSCRIPTION_MODEL=whisper-1
```

### Поведение

```env
MESSAGE_DEBOUNCE_MS=10000
WORKER_CONCURRENCY=20
CONVERSATION_HISTORY_MAX_MESSAGES=30
CONVERSATION_HISTORY_TTL_DAYS=30
CONVERSATION_LOCK_TTL_MS=120000
IDEMPOTENCY_TTL_SECONDS=86400
LOG_LEVEL=info
LOG_MESSAGE_CONTENT=false   # true только в dev
```

---

## Режимы

### Local mock run (по умолчанию)

```env
MOCK_EXTERNALS=true
```

Никаких реальных credentials не нужно:

- **CRM mock** возвращает тестовую квартиру;
- **LLM mock** возвращает детерминированный structured result;
- **GreenAPI mock** не отправляет сообщение, а сохраняет его;
- **Transcription mock** возвращает фиксированный текст.

Можно точечно отключить mock сервиса: `MOCK_CRM`, `MOCK_LLM`,
`MOCK_GREENAPI`, `MOCK_TRANSCRIPTION`.

Проверить, что было сгенерировано в mock-режиме:

```bash
curl http://localhost:3000/debug/state
curl http://localhost:3000/debug/config
```

### Real mode

```env
MOCK_EXTERNALS=false
CRM_BASE_URL=https://admin.batumi-key.homes/api
CRM_API_KEY=<N8N_API_KEY арендной CRM>
LLM_API_KEY=...    LLM_MODEL=...    LLM_BASE_URL=...
GREENAPI_INSTANCES=[{"id":"<idInstance>","managerId":2}, ...]
```

### Чеклист подключения к прод (по команде, отдельно от кода)

1. Вписать в `.env` прод-значения (см. Real mode выше).
2. Поднять сервис (docker compose / Coolify) с Redis.
3. В кабинете GreenAPI для каждого инстанса перевести
   webhook URL с CRM на `https://<batymi-host>/webhooks/greenapi/<idInstance>`
   (Batymi сам форвардит всё в CRM `/api/greenapi/webhook/<id>`).
4. Проверить `GET /health/ready` и один тестовый диалог через
   `/debug/simulate-message` (только dev-режим).
5. Убедиться, что в CRM появляются interactions (диалоги → has_reply).

---

## Webhook URL для GreenAPI

Для каждого instance укажите в GreenAPI (входящие сообщения
`incomingMessageReceived`) URL:

```text
http(s)://<ваш-хост>:3000/webhooks/greenapi/<idInstance>
```

Пример: `https://bot.example.com/webhooks/greenapi/7107577616`

---

## Health check

```bash
curl http://localhost:3000/health/live    # {"ok":true}
curl http://localhost:3000/health/ready   # redis/queue/worker/config/instances
```

`/health/ready` проверяет Redis, worker, наличие instances и обязательные
переменные (в real mode — CRM/LLM ключи и `GREENAPI_WEBHOOK_SECRET`). Токены
GreenAPI instance здесь не требуются: Batymi принимает webhook, а отправляет
ответы CRM.

---

## Ручной тест (fake webhook)

```bash
curl -X POST http://localhost:3000/webhooks/greenapi/mock-instance-1 \
  -H "Content-Type: application/json" \
  -d '{
    "typeWebhook": "incomingMessageReceived",
    "idMessage": "manual-1",
    "timestamp": 1700000000,
    "instanceData": { "idInstance": "mock-instance-1", "typeInstance": "whatsapp" },
    "senderData": { "chatId": "995555123456@c.us", "chatName": "Test" },
    "messageData": {
      "typeMessage": "textMessage",
      "textMessageData": { "textMessage": "Да, я собственник, можно работать" }
    }
  }'
```

Или скриптом:

```bash
npm run send-webhook -- "Да, я собственник"
# INSTANCE_ID=mock-instance-1 CHAT_ID=995555123456@c.us npm run send-webhook
```

Debug-симулятор (только dev/test, проходит через тот же pipeline):

```bash
curl -X POST http://localhost:3000/debug/simulate-message \
  -H "Content-Type: application/json" \
  -d '{"instanceId":"mock-instance-1","chatId":"995555123456@c.us","text":"Да, я собственник, можно работать"}'
```

---

## Тесты

```bash
npm test                 # unit + integration + scenarios (без реальных API)
npm run test:unit
npm run test:integration
npm run typecheck
npm run smoke            # требует запущенное приложение
npm run eval             # реальная LLM, тратит токены (нужен LLM_API_KEY)
```

`npm run eval` прогоняет `tests/conversations/owner-dialogue-corpus.ts`
через настроенную реальную модель и локальный HTTP-сервер CRM. JSON-отчёт содержит
ответ, CRM до/после, журнал записей, попытки и ошибки каждого хода.
`npm run eval:scripted` проверяет тот же путь с явно заданными выводами модели.
Оба прогона не отправляют WhatsApp и не проверяют production CRM.

### Что покрыто

- normalizer: text / audio / unsupported / non-incoming;
- conversation key isolation (`instance1:user1` ≠ `instance2:user1`);
- CRM/LLM Zod-схемы (плохой ответ не проходит молча);
- бизнес-правила: realtor → stop, terminal, manager filter;
- batching: 5 быстрых сообщений → 1 LLM run;
- concurrency: 5 instances × 10 контактов параллельно, без смешивания данных;
- same-conversation race: нет двух конфликтующих обработок, сообщения не теряются;
- duplicate webhook, unsupported type, audio → transcription → pipeline;
- conversation regression suite.

---

## Структура

```text
src/
  server.ts                 # wiring: config, redis, worker, api
  app.ts                    # Fastify + health endpoints
  services.ts               # DI-контейнер (простые зависимости)
  config/                   # env + GreenAPI instances
  webhooks/                 # routes + normalizer
  buffer/                   # store (redis/memory), keys, debounce ingest
  queue/                    # connection, scheduler, BullMQ worker
  conversation/             # conversation service + history
  crm/                      # CRM client + schemas + reply sender + webhook proxy
  greenapi/                 # GreenAPI webhook schemas + normalizer
  agent/                    # prompt, schemas, actions, gates, LLM provider
  transcription/            # audio → text
  observability/            # pino logger, debug recorder
tests/
  unit/ integration/ conversations/ fixtures/
scripts/
  send-test-webhook.ts  run-smoke-test.ts  run-eval.ts
```

---

## Архитектурные решения (важно)

- **Аудио транскрибируется в worker**, а не в webhook, чтобы webhook отвечал
  мгновенно. Транскрипт попадает в тот же batch как обычный текст.
- **Terminal conversations** (`listing_removed`, `disagreed`, `archived`, `no_whatsapp`,
  `contact_type=realtor`) не перезапускают квалификацию и не зовут LLM.
  Новое сообщение логируется и пишется в историю, автоответ не отправляется.
  `qualified` также терминален безусловно, даже при исключении из env.
- **Прозрачный прокси вебхуков**: Batymi — единственный получатель вебхуков
  GreenAPI, но каждый валидный сырой вебхук уходит в CRM через BullMQ-очередь
  `webhook-forward` (3 попытки). Детерминированный id задачи и удержание
  завершённых id на `IDEMPOTENCY_TTL_SECONDS` не позволяют повторному
  webhook или потерянному ответу CRM создать вторую interaction. Ack
  подтверждается после постановки задачи.
- **Ответы только через CRM `/api/chat/reply`** с явным `instance_id`
  принимающего инстанса: CRM пишет исходящее в interactions и гарантирует
  правило «отвечать с того же номера» без гонки с прокси.
- **Idempotency** по `seen:{instanceId}:{idMessage}` (Redis `SET NX` + TTL).
- **Retries**: BullMQ `attempts: 3` + exponential backoff; при финальном сбое
  batch возвращается в pending и планируется ограниченный ручной retry
  (не более 2), после чего фиксируется `run.failed.permanent`.
- **API и worker — один процесс**, но легко разделяются:
  `API_ENABLED=false` / `WORKER_ENABLED=false` из одного image.

---

## Known limitations

- V1 обрабатывает `text` и `audio`; `image`/`document` логируются как
  неподдерживаемые (архитектура готова к расширению).
- Терминальные диалоги не получают автоответ.
- Форвард вебхука в CRM при финальном сбое (3 попытки) теряется — фиксируется
  error-логом; входящее при этом всё равно обработано движком.
- Ответ «уже сдана» записывает `availability_status=rented` адресно у квартиры.
  CRM в той же транзакции переводит контакт в `listing_removed` («Объявление снято»).
  После одного финального ответа агент молчит; `listing_removed` и `rented`
  проверяются перед вызовом LLM независимо от `TERMINAL_CRM_STATUSES`.
  Прочтения и доставки не возвращают контакт в `read`; для возобновления работы
  менеджер явно меняет статус контакта и доступность квартиры в CRM.
- LLM-vs-LLM simulator не реализован; eval использует production-код проверки
  действий и ответов, но не заменяет проверку реальных CRM и GreenAPI.

---

## Проверка качества диалога

Модель выбирает следующий вопрос по реальным CRM Interaction и снимку Listing.
Пять пунктов: актуальность/доступность, роль, сотрудничество, месячная цена/валюта,
минимальный срок. Вид/ЖК и другие добровольные детали необязательны. Код не извлекает
факты и не переписывает реплики через regex. Structured цикл ограничен:
план → проверка → CRM → результаты и обновлённый снимок → финальный текст модели.
Если записей нет, хватает одного вызова. После одного исправления невалидный план
попадает в quarantine с run ID; самодельной резервной анкеты нет.
Целиком обёрнутый в Markdown-блок JSON принимается как транспортный формат;
произвольный текст вокруг JSON и невалидные действия по-прежнему отклоняются.

История: последние 50 WhatsApp Interaction одного инстанса плюс первое исходящее;
автор/message ID обеспечивают дедупликацию и остановку после ручного ответа менеджера.
Redis дополняет ещё не попавшие в CRM сообщения.

Короткое «нет»/«net» на первое обращение об актуальности и долгосрочной аренде
завершает опрос: `disagreed`, дословный ответ с контекстом в `agent_notes`, один
короткий финальный ответ. Приветствие отдельным сообщением перед отказом не меняет
этот смысл. Причина не выдумывается: `rented` допустим только при явном «уже сдана»;
отрицательный ответ на вопрос о ЖК/депозите не закрывает сотрудничество.
Положительный ответ на вопрос о текущей сдаче записывает `availability_status=available`
в том же ходе. Цена из объявления подтверждается одним вопросом с её числом/валютой.

Активный batch сохраняет план, число завершённых действий и финальную реплику;
retry сначала сверяет CRM.
При подтверждённой отправке восстановление не вызывает LLM/CRM/send повторно.
Для нескольких Listing сначала нужен выбор по адресу; qualified автоматически
запрещён, потому что статус завершает разговор для всего Contact.

Acceptance: `npm test` проверяет каждый ход `tests/conversations/owner-dialogue-corpus.ts`
через `handleConversationJob`, `RealCrmClient` и локальный HTTP-сервер CRM.
`npx tsx scripts/check-owner-dialogue.ts` использует тот же корпус и настроенную
реальную LLM без WhatsApp и production CRM. Старые `run-eval.ts` и
`check-dialogue-quality.ts` — изолированные проверки, не выпускной gate.

Защищённая трасса: `RUN_TRACE_KEY` — 32 случайных байта (64 hex или base64url),
`RUN_TRACE_DIR` — закрытый каталог вне Git/HTTP, `RUN_TRACE_RETENTION_DAYS` — 7
по умолчанию. Без ключа трасса отключена с явным предупреждением. События AES-256-GCM
хранят вход/message IDs, CRM before/after, prompt/model, raw output, действия,
результаты и outbound ID. Linux: каталог 0700/файлы 0600; Windows: ограничьте NTFS ACL,
chmod недостаточно. Ключ хранить отдельно от трассы. Retention очищается при записи;
для простаивающего сервиса оператор отдельно удаляет просроченные файлы.

## Безопасность

- Ни один секрет из старого n8n JSON не перенесён в код.
- Все ключи — только через ENV. `.env` в `.gitignore`, `.env.example` —
  плейсхолдеры.
- В старом n8n export были обнаружены реальные credentials — их необходимо
  перевыпустить (см. итоговый отчёт).
