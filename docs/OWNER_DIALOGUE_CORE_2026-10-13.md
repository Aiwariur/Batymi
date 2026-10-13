# Owner-dialogue core (планировщик owner_dialogue_v1) — 2026-10-13

Замена `semantic_v3`: `planCooperation()` стал тонким адаптером над ядром
`src/conversation/owner-dialogue-core.ts`, перенесённым дословно из
main-репо (ветка `test/owner-chat-simulator`, модуль `owner-dialogue/`).

## Что изменилось

- **Реплику пишет только модель.** Словарь `words`, intent-классификация и
  keyword-обработка коротких да/нет удалены. Ядро даёт модели историю+факты,
  валидирует JSON-решение и страхует ремонт-раундами (до 3 вызовов).
- **Контракт решения**: `{"action":"reply|silence|handoff|stop","reply":...,
  "language":"ru|en|ka","crm_status":"agreed|disagreed|listing_removed|realtor|null","reason":...}`.
- **handoff и stop всегда молчаливые**: собственнику не уходит ни слова.
  handoff → ручной захват менеджером (`manualHandoffReason` =
  `owner_dialogue: <причина модели>`, свободный текст), stop → терминальный
  CRM-статус причины.
- **agreed** — только за реальное согласие сотрудничать или «квартира сдаётся».
  Вопрос о комиссии и подтверждение адреса/собственности — `crm_status null`.
- **Бот — живой менеджер**: промпт запрещает признаваться в ИИ и упоминать
  «передачу менеджеру»; гварды ловят повторы, транслит (отвечаем кириллицей),
  выдумки про клиента.
- Сбой модели после ремонт-раундов → `AgentOutputError` → карантин и обзор
  оператором; запасной заготовленный вопрос НЕ отправляется.

## Что не изменилось

Транспорт: вебхуки GreenAPI, дебаунс, батчи, локи, чекпойнты, outbound-intent,
изоляция линий, ручной перехват (manager takeover), партнерский фильтр.
Бамп `COOPERATION_PLANNER_VERSION` → старые чекпойнты перезапланировываются
по действующей механике `conversation.service.ts`.

## Env

- `AGENCY_NAME` (default `Batumi Key`) — название агентства в промпте.
  Имя представителя линии — как раньше, из конфига инстансов.
- `facts.knownClient` фиксируется в `false` (клиента на письмо нет).

## Тесты

- `tests/unit/cooperation-agent.test.ts` — адаптер и гварды ядра (TDD).
- `tests/integration/cooperation-handoff.test.ts` — конвейер с моком
  LLM-транспорта (молчаливость, чекпойнты, takeover, карантин).
