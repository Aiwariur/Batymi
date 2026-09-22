# Outbound safety

Batymi treats a CRM reply as a remote side effect that cannot be rolled back.
The conversation store therefore keeps an in-flight batch and one durable
outbound intent for that batch.

Before the CRM request, the intent is persisted as `prepared` and atomically
claimed as `sending`. A worker may send only an intent it successfully claims.
After a successful CRM response, the worker persists `sent` before acknowledging
the batch and its history. The active batch is acknowledged only after all of
those steps complete.

If the CRM request times out, returns an unusable response, or the state write
after the request fails, the intent is marked `ambiguous` when possible and the
conversation is quarantined. New webhook messages remain buffered, but no
automatic job may send another reply for that conversation. An intent left in
`sending` by a process crash is treated the same way on the next worker start.
An operator must reconcile the CRM dialog and then explicitly clear or repair
the durable intent before resuming processing.

The store also moves a drained batch into an active record instead of deleting
it. A worker restart can therefore recover a batch that was drained before a
crash. A successful acknowledgement removes the active batch atomically. New
messages arriving while a batch is running stay in the pending buffer and are
scheduled after the active batch is acknowledged.

This is deliberately fail-closed. It prevents automatic duplicate replies
after an unknown remote outcome, but it cannot prove whether Green API delivered
an unknown request. Exactly-once delivery requires an idempotency key supported
by the receiver (or a provider-side message lookup). The intent ID is stable and
available for future CRM/provider reconciliation; it is not currently a claim
that the remote API itself deduplicates requests.

The integration tests inject a lost response, a failed post-send persistence
write, a crash after intent claim, and duplicate workers. They run against the
in-memory store. The opt-in Redis checks also exercise concurrent outbound
claim exclusivity and atomic ingress/scheduler recovery against the Redis
implementation. On 2026-09-22 both checks passed against a disposable local
`redis:7-alpine` container. Production Redis failover and deployment health
remain unvalidated.
