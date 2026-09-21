# Batymi — движок ответов собственникам (долгосрочная аренда)

Небольшой production-ready backend на TypeScript, который заменяет n8n-агентов
арендной CRM SS.GE-Rent (`n8n/N8N_AGENT_PROMPT.md` + `n8n/N8N_AGENT_AGREED_PROMPT.md`)
— обработка входящих WhatsApp-сообщений собственников (GreenAPI + CRM + LLM).

Обслуживает несколько GreenAPI instances / WhatsApp-номеров одним процессом,
собирает быстрые сообщения пользователя в один batch, обогащает их данными из
CRM, делает **один** structured LLM call, выполняет разрешённые CRM-действия и
отправляет короткий ответ.

**Режим аренды (текущий):** движок квалифицирует собственников долгосрочной
аренды — фаза 1 (`new/sent/delivered/read → agreed`) и фаза 2 (`agreed →
qualified`, сбор арендных условий конкретного Listing). Ответы отправляются
только через CRM `/api/chat/reply`, входящие вебхуки прозрачным прокси
форвардятся в CRM — CRM остаётся источником правды по interactions.

---

## Rent mode — как движок встроен в арендную CRM

```text
GreenAPI ──► Batymi /webhooks/greenapi/:id ──► прокси сырого вебхука ──► CRM /api/greenapi/webhook/<id>
                    │                                            (interactions, delivery-статусы, has_reply)
                    ▼
              Redis pending buffer → debounce → BullMQ → conversation lock
                    │
                    ▼
        GET /api/flat/by-phone (+rental_terms) → фаза по crm_status
                    │
                    ▼
              один LLM call (JSON: reply + actions)
                    │
              детерминированные гейты (код, не промпт)
                    │
        ┌───────────┼──────────────────────────────┐
        ▼           ▼                              ▼
  /api/status/set  /api/contacts/<phone>/deal   /api/chat/reply
  (agreed/qualified/disagreed)  + /rental-terms  (ответ с «того же» инстанса)
```

### Фазы диалога (по `crm_status` контакта)

| Фаза | Статусы CRM | Промпт | Разрешённые действия |
| --- | --- | --- | --- |
| primary | `new/sent/delivered/read` | `system-prompt.ts`, секция фазы 1 (порт `N8N_AGENT_PROMPT.md`, доработан) | `set_contact_type`, `update_rental_terms`, `update_deal_info`, `set_crm_status=agreed|disagreed` |
| agreed | `agreed` | `system-prompt.ts`, секция фазы 2 (сборное сообщение «что клиенты спрашивают чаще всего») | то же + `set_crm_status=qualified` (при полном наборе) |
| qualified | `qualified` | короткие содержательные ответы | **никаких** — все действия блокируются гейтом |
| terminal | `disagreed/archived/no_whatsapp`, `contact_type=realtor` | — | LLM не вызывается, ответ не отправляется |

### Детерминированные гейты (`src/agent/gates.ts`)

Правила диалогового агента, проверяемые кодом до любого вызова CRM:

- статусы `new/sent/delivered/read/sold/archived/no_whatsapp/listing_removed`
  движок никогда не выставляет (в т.ч. `sent`, который в CRM шлёт сообщение);
- при переводе в `agreed` движок автоматически пишет
  `publication_consent=true` (согласие на сотрудничество покрывает публикацию,
  отдельно у собственника разрешение не запрашивается; явная запись агента
  в том же пакете приоритетнее — см. `src/agent/actions.ts`);
- `qualified` — только в фазе agreed и только при полном наборе
  (цена/валюта/`month`/`rent_long_term`/`available`/мин. срок/комиссия/
  window_view/ЖК-или-«нет ЖК»), включая поля,
  которые LLM пишет этими же действиями. Кадастровый номер и
  `publication_consent` в гейт не входят: кадастр нужен только при продаже,
  разрешение на публикацию у собственника не запрашивается;
- при >1 активном листинге запись условий без явного `listingId` запрещена;
- пустые строки отбрасываются — контракт «"" = не перезаписывать» соблюдается
  автоматически; неизвестные `listingId` отклоняются;
- ЖК назначается только точным матчингом по каталогу `GET /api/complexes`
  (маркеры «нет ЖК» id не получают).

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
                              │ validate + idempotency (idMessage)
                              │ + прозрачный прокси сырого вебхука в CRM
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

- **Webhook делает минимум работы**: валидация, idempotency, буфер, постановка
  отложенного job. Никогда не ждёт CRM/LLM/транскрипцию/отправку.
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
| Check manager (`== 2`) | `ALLOWED_MANAGER_IDS` / `managerId` на instance |
| N8N_AGENT_PROMPT (фаза 1, gpt-4o-mini) | `system-prompt.ts` → primary-фаза |
| N8N_AGENT_AGREED_PROMPT (фаза 2) | `system-prompt.ts` → agreed-фаза |
| tools (get_flat/set_status/set_type/update_deal/list_complexes) | 4 structured-действия + гейты + матчинг ЖК в коде |
| Send Reply | `POST /api/chat/reply` (CRM сам пишет interaction и выбирает инстанс) |
| — (новое) | qualified-фаза: содержательные ответы без действий; терминалы без LLM |

Изменения относительно n8n: **риелтор → `set_contact_type=realtor` и остановка
квалификации**; **`qualified`-диалоги не терминальны** — движок отвечает по
существу, но не меняет CRM; **`set_crm_status=sent` невозможен в принципе**
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

### CRM (арендная CRM SS.GE-Rent)

```env
CRM_BASE_URL=https://admin.batumi-key.homes/api
CRM_API_KEY=            # N8N_API_KEY этой CRM (X-API-Key)
ALLOWED_MANAGER_IDS=2   # SENT_AUTO_MANAGER_ID: «контакты, которым уже писали»
TERMINAL_CRM_STATUSES=disagreed,archived,no_whatsapp
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

`/health/ready` проверяет Redis, worker, наличие instances и обязательных
переменных (в real mode — CRM/LLM ключи).

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

`npm run eval` прогоняет `tests/conversations/scenarios.ts` (27 сценариев)
через реальную модель и печатает pass rate и список провалов.

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
- **Terminal conversations** (`disagreed`, `archived`, `no_whatsapp`,
  `contact_type=realtor`) не перезапускают квалификацию и не зовут LLM.
  Новое сообщение логируется и пишется в историю, автоответ не отправляется.
  `qualified` — отдельная история: LLM отвечает по существу, но гейт блокирует
  любые CRM-действия.
- **Прозрачный прокси вебхуков**: Batymi — единственный получатель вебхуков
  GreenAPI, но каждый сырой вебхук уходит в CRM через BullMQ-очередь
  `webhook-forward` (3 попытки). CRM остаётся источником правды по
  interactions; ack GreenAPI не блокируется.
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
- `availability_status=rented` движок не ставит (триггер TG-очистки постов) —
  снятие квартиры с публикации остаётся за CRM/менеджером.
- LLM-vs-LLM simulator не реализован; `tests/conversations` и evaluator —
  фундамент для него, production code от eval не зависит.

---

## Безопасность

- Ни один секрет из старого n8n JSON не перенесён в код.
- Все ключи — только через ENV. `.env` в `.gitignore`, `.env.example` —
  плейсхолдеры.
- В старом n8n export были обнаружены реальные credentials — их необходимо
  перевыпустить (см. итоговый отчёт).
