---
name: JaaS video provider
description: NovaLuth’s video provider priority and fallback behavior
---

NovaLuth should prefer Jitsi as a Service when its server-side signing configuration is complete, while retaining public Jitsi as a fail-closed operational fallback.

**Why:** JaaS avoids requiring the first participant to authenticate as a moderator, but its credentials and provider availability are environment-dependent. A meeting must remain usable without storing provider tokens or making NovaLuth join the call.

**How to apply:** Generate a short-lived participant JWT only when opening a valid appointment, never persist it, disable recording/transcription-related features, and expose a public Jitsi fallback room when JaaS is unavailable or its embedded client fails.