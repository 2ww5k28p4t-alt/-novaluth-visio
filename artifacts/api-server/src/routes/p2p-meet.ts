import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { GetMeetConfigResponse, GetMeetIceConfigResponse } from "@workspace/api-zod";
import { buildP2PIceServers } from "../lib/p2p-meet";

const router: IRouter = Router();

router.get("/meet/config", (_req, res): void => {
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.json(GetMeetConfigResponse.parse({
    maxPeers: Math.max(2, Number(process.env.MAX_PEERS_PER_ROOM ?? 8)),
    accessCodeRequired: Boolean(process.env.ACCESS_CODE),
    forceRelay: String(process.env.FORCE_RELAY ?? "false") === "true",
  }));
});

router.get("/meet/ice", (_req, res): void => {
  const iceServers = buildP2PIceServers(crypto.randomUUID());
  const forceRelay = String(process.env.FORCE_RELAY ?? "false") === "true";
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.json(GetMeetIceConfigResponse.parse({
    iceServers,
    iceTransportPolicy: forceRelay ? "relay" : "all",
    iceCandidatePoolSize: 2,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    warning:
      iceServers.length === 0
        ? "Aucun serveur STUN/TURN configuré : les appels ne fonctionneront qu'en réseau local."
        : null,
  }));
});

export default router;