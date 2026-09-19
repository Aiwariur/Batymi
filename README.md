# Orange Group — WhatsApp AI Agent Backend

Небольшой production-ready backend на TypeScript, который заменяет громоздкий
n8n workflow обработки входящих WhatsApp-сообщений (GreenAPI + CRM + LLM).

Обслуживает несколько GreenAPI instances / WhatsApp-номеров одним процессом,
собирает быстрые сообщения пользователя в один batch, обогащает их данными из
CRM, делает **один** structured LLM call, выполняет разрешённые CRM-действия и
отправляет короткий ответ.

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
                  (Zod-validated)     GreenAPI sendMessage
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

### Соответствие старому n8n workflow

| n8n | новый backend |
| --- | --- |
| GREENAPI Trigger | `POST /webhooks/greenapi/:instanceId` + normalizer |
| Switch3 (audio/text/image) | `message-buffer` + `transcription.service` |
| Redis counter/timestamp/wait/pop | `buffer/` (debounce через BullMQ + Redis token) |
| Merge3/4/5, Simple Memory | `conversation.service` + `history.service` |
| Get Status1 (`/flat/by-phone`) | `crm.client.getFlatsByPhone` |
| Check manager1 (`== 2`) | `ALLOWED_MANAGER_IDS` / `managerId` на instance |
| AI Agent2 + tools | `agent/` (prompt + structured actions) |
| Send message | `greenapi.client.sendMessage` |

Изменение относительно старого JSON: **риелтор → `set_contact_type=realtor` и
немедленная остановка квалификации** (не продолжаем сценарий собственника).

---

## Переменные окружения

Полный список — в `.env.example`. Ключевые:

### Redis

```env
REDIS_URL=redis://redis:6379   # внутри docker compose
REDIS_URL=redis://localhost:6379  # локально
```

### GreenAPI instances

```env
GREENAPI_API_URL=https://api.green-api.com

# Вариант A: JSON-массив (рекомендуется)
GREENAPI_INSTANCES=[{"id":"7107577616","token":"...","managerId":2}]

# Вариант B: нумерованные переменные
GREENAPI_INSTANCE_1_ID=
GREENAPI_INSTANCE_1_TOKEN=
GREENAPI_INSTANCE_1_MANAGER_ID=
```

### CRM

```env
CRM_BASE_URL=https://admin.hatumi.space/api
CRM_API_KEY=
ALLOWED_MANAGER_IDS=2
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
CRM_BASE_URL=...   CRM_API_KEY=...
LLM_API_KEY=...    LLM_MODEL=...    LLM_BASE_URL=...
GREENAPI_INSTANCES=[...]
```

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
  crm/                      # CRM client + schemas
  greenapi/                 # GreenAPI client + schemas
  agent/                    # prompt, schemas, actions, LLM provider
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
- **Terminal conversations** (`qualified`, `disagreed`, `contact_type=realtor`)
  не перезапускают квалификацию. Новое сообщение логируется и пишется в
  историю, CRM-действия не выполняются, автоответ не отправляется.
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
- Отправка GreenAPI не идемпотентна: крайне маловероятный двойной ответ при
  потере ответа API после успешной отправки.
- LLM-vs-LLM simulator не реализован; `tests/conversations` и evaluator —
  фундамент для него, production code от eval не зависит.

---

## Безопасность

- Ни один секрет из старого n8n JSON не перенесён в код.
- Все ключи — только через ENV. `.env` в `.gitignore`, `.env.example` —
  плейсхолдеры.
- В старом n8n export были обнаружены реальные credentials — их необходимо
  перевыпустить (см. итоговый отчёт).
