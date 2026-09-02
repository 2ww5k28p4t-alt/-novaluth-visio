---
name: Shutdown fallback test fixtures
description: A process-fixture timing constraint for testing bounded PostgreSQL shutdown recovery
---

Detached process fixtures used to exercise shutdown recovery must wait until the process has a readable command line before publishing its PID file.

**Why:** A process launched from a command substitution can still be starting when the parent shell exits. An immediate ownership check may then observe an empty or already-exited `/proc` entry and falsely test the SIGTERM-success path instead of the SIGKILL fallback.

**How to apply:** When simulating an owned stubborn PostgreSQL process, detach it from the launcher, make it ignore SIGTERM, and poll its `/proc/<pid>/cmdline` readiness before writing the PID file.