# CRM contract QA

Последняя локальная проверка контрактов Batymi и Flask CRM:

```powershell
cd Batymi
npm run typecheck
npm test

cd ..
$env:ISOLATED_REPO_CWD='true'
$env:ISOLATED_PYTEST_ARGS='tests/test_rental_stage1.py tests/test_locked_complex_catalog.py tests/test_whatsapp_webhook_contract.py tests/test_batymi_crm_http_contract.py'
.venv\Scripts\python.exe scripts\run_isolated_tests.py
```

Результаты базовой проверки: Vitest — **100 passed, 2 skipped** без Redis.
Дополнительный opt-in прогон с локальным disposable Redis — **102 passed**
(включая 2 Redis checks); isolated Python suite — **29 passed, 2 warnings,
exit code 0**.

`test_batymi_crm_http_contract.py` поднимает реальный Flask WSGI сервер на временной SQLite базе и запускает настоящий `RealCrmClient` из Batymi по HTTP. В сценарии есть два Listing: обновляется только явно выбранный второй Listing, пустая строка не затирает поле, а `setStatus(agreed, suppressTelegram=true)` проверяется через spy Telegram notifier.

Webhook contract tests также проверяют Bearer authentication, проверку `idInstance`, повторную доставку и конкурентную дедупликацию на SQLite через `BEGIN IMMEDIATE`, возврат `500` при ошибке сохранения и защиту delivery rank от гонок.

Проверка не включает production PostgreSQL/Redis failover, LLM/eval runs,
GreenAPI/Telegram, deployment или реальные отправки. Redis-проверки выполнены
только против локального контейнера `redis:7-alpine` на localhost.
