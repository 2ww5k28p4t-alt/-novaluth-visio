---
name: TURN port advertisement
description: When NovaLuth Meet should include TLS port 443 in its ICE server list
---

TURN over TLS on port 443 must be opt-in. Enable it only when Coturn actually listens on that port, typically on a separate host.

**Why:** In a single-host deployment, the HTTPS proxy normally owns port 443. Advertising a closed or unrelated TURN endpoint delays ICE negotiation and can make connectivity troubleshooting misleading.

**How to apply:** Keep port 443 disabled by default. Enable the dedicated setting only after confirming Coturn's alternate TLS listener is reachable externally; ports 3478 and 5349 remain the standard advertised endpoints.