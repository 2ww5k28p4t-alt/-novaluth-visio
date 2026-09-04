---
name: Socket.IO behind the artifact proxy
description: Routing constraint for browser WebSockets connected to the shared API artifact
---

The Socket.IO path must be listed explicitly in the API artifact service paths and must be identical in the server and browser client configuration.

**Why:** The Replit artifact proxy forwards only declared service paths; an undeclared WebSocket path can be dropped even when the HTTP API and server are healthy.

**How to apply:** When adding a realtime browser feature to the shared API, use a namespaced path under the API route, declare that exact path in the artifact manifest, and smoke-test a real Socket.IO handshake.

For short transport interruptions, do not rely on Socket.IO's transport id alone: keep a per-tab participant identity, preserve the room peer through a bounded recovery window, and route signals through the current transport id.

**Why:** A proxied reconnect can create a new Socket.IO session even when the browser reconnects quickly, so socket-id-only rooms produce duplicate peers or lose signaling.

**How to apply:** Treat an explicit client leave as immediate removal, but delay network-disconnect expiry long enough for the client to rejoin and renegotiate WebRTC.

Automated browser checks must use the artifact-router origin rather than the frontend dev-server port.

**Why:** NovaLuth Meet relies on same-origin `/api` HTTP and WebSocket routes; the Vite service does not proxy those routes when opened directly.

**How to apply:** Exercise `/meet` through the routed preview origin, with fake media devices and a per-page network interruption, so the test covers the same HTTP, Socket.IO, and WebRTC boundaries as the app preview.