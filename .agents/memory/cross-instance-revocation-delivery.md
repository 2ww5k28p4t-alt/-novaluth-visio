---
name: Cross-instance revocation delivery
description: Reliability requirements for security-sensitive events delivered through PostgreSQL notifications.
---

Security-sensitive cross-instance revocations must not rely on best-effort notifications alone. The listener must be ready before the service accepts traffic, and every listener reconnection must reconcile connected principals against authoritative database state.

**Why:** PostgreSQL notifications emitted before `LISTEN` or while its connection is unavailable are not replayed. Without reconciliation, a missed event can leave access granted indefinitely.

**How to apply:** For any revocation that must affect existing connections, subscribe before opening the HTTP listener, retry failed subscriptions with handled errors, and query authoritative state after each successful subscription.