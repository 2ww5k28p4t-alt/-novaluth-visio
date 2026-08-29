---
name: Transactional email outbox
description: Durable delivery boundary for NovaLuth notifications.
---

Any business mutation that triggers an email must enqueue the notification in the same database transaction. Delivery is at-least-once: the provider call and delivery-state update cannot be one atomic operation, so a stable idempotency key must accompany every retry.

**Why:** Sending directly after a mutation can lose the notification between the commit and the provider call; a process crash after provider acceptance can also create a duplicate unless the provider receives the same idempotency key.

**How to apply:** Keep deduplication keys event-specific, retain failed/dead messages with bounded retry metadata, and expose queue state to administrators without exposing recipient content or provider credentials.