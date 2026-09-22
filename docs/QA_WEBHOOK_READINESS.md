# Webhook and readiness QA

Validated locally on 2026-09-22 without external sends. With the opt-in Redis
checks enabled against a disposable local Redis container:

```text
npm run typecheck  -> passed
npm run build      -> passed
npm test           -> 102 passed
```

The focused webhook run covered auth rejection, id-only readiness, instance
and chat validation, concurrent duplicate delivery, proxy enqueue failure,
scheduler recovery, and normalization:

```text
npx vitest run tests/unit/normalizer.test.ts tests/integration/webhook.test.ts tests/integration/batching.test.ts tests/integration/concurrency.test.ts
-> 27 passed
```

The Redis script test is opt-in and runs only when both variables point to a
test Redis instance:

```text
OUTBOUND_REDIS_URL=redis://... REDIS_TEST_URL=redis://... npx vitest run tests/integration/redis-outbound-safety.test.ts
```

The focused Redis run passed both tests (outbound claim exclusivity and atomic
ingress/scheduler recovery) against Redis 7.4.11 in a disposable
`redis:7-alpine` container bound to localhost only. Live production Redis
failover, PostgreSQL/CRM receiver authentication, LLM calls, GreenAPI
delivery, and deployment health were not exercised here.
