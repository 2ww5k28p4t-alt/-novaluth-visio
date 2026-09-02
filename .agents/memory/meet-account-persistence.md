---
name: Meet account persistence
description: Architecture boundary for adding authenticated access to NovaLuth Meet
---

Meet authentication must reuse or extend NovaLuth identity and persist account data in PostgreSQL. Do not adopt the standalone archive's local JSON user store.

**Why:** NovaLuth is deployed with autoscaling, where local filesystem data is ephemeral and can diverge between instances. A second account system would also conflict with the existing artisan, musician, and administration access paths.

**How to apply:** If authenticated Meet access is added, define database-backed identities and sessions that compose with existing NovaLuth authorization, then authenticate the Socket.IO handshake against the same session.