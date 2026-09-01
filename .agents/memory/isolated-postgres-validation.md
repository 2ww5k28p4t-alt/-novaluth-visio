---
name: Isolated PostgreSQL validation
description: Disposable local PostgreSQL checks need explicit runtime paths in the Replit container.
---

Repository-level schema validation can use the installed PostgreSQL server binaries without a container service, but the temporary server must be given both a dynamic TCP port and a writable Unix-socket directory.

**Why:** The default PostgreSQL socket directory may not exist in the Replit container, and fixed ports can collide with other workflows.

**How to apply:** Keep isolated database checks self-cleaning and avoid reusing the development `DATABASE_URL`; configure the temporary cluster's socket and port explicitly.