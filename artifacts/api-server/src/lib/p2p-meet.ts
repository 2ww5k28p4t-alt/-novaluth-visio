import crypto from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { logger } from "./logger";
import {
  accountForSession,
  inactiveMeetAccountIds,
  isMeetAuthRequired,
  onMeetAccountDisabled,
  sessionTokenFromCookie,
} from "./p2p-meet-auth";

const MAX_PEERS = Math.max(2, Number(process.env.MAX_PEERS_PER_ROOM ?? 8));
const ACCESS_CODE = process.env.ACCESS_CODE ?? "";
const LOG_SALT = process.env.LOG_SALT ?? process.env.SESSION_SECRET ?? "novaluth-meet";
const JOIN_WINDOW_MS = 15 * 60 * 1000;
const JOIN_ATTEMPT_LIMIT = 15;
const RECOVERY_WINDOW_MS = Math.max(
  10_000,
  Number(process.env.MEET_RECOVERY_WINDOW_MS ?? 120_000),
);

type RoomPeer = { name: string; socketId: string; connected: boolean };
type RoomState = {
  peers: Map<string, RoomPeer>;
  passwordSalt: string | null;
  passwordHash: Buffer | null;
};
type SignalPayload = { to?: string; data?: unknown };
type RoomPayload = {
  room?: unknown;
  name?: unknown;
  code?: unknown;
  roomPassword?: unknown;
  participantId?: unknown;
};
type AccountDisabledSubscriber = typeof onMeetAccountDisabled;

function sanitize(value: unknown, maxLength: number) {
  return String(value ?? "")
    .replace(/[<>"'`\\]/g, "")
    .trim()
    .slice(0, maxLength);
}

function normalizeRoom(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\-_ ]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function fingerprint(value: string) {
  return crypto.createHmac("sha256", LOG_SALT).update(value).digest("hex").slice(0, 16);
}

function hashRoomPassword(password: string, salt: string) {
  return crypto.scryptSync(password, salt, 32);
}

function roomPasswordMatches(room: RoomState, password: string) {
  if (!room.passwordHash || !room.passwordSalt) return true;
  const candidate = hashRoomPassword(password, room.passwordSalt);
  return candidate.length === room.passwordHash.length
    && crypto.timingSafeEqual(candidate, room.passwordHash);
}

export function buildP2PIceServers(userId: string) {
  const stunUrl = process.env.STUN_URL ?? "";
  const turnHost = process.env.TURN_HOST ?? "";
  const turnTls443 = String(process.env.TURN_TLS_443 ?? "false") === "true";
  const turnSecret = process.env.TURN_STATIC_AUTH_SECRET ?? "";
  const turnUsername = process.env.TURN_USERNAME ?? "";
  const turnPassword = process.env.TURN_PASSWORD ?? "";
  const turnTtl = Math.max(60, Number(process.env.TURN_TTL ?? 43200));
  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [];
  const turnUrls = [
    `turn:${turnHost}:3478?transport=udp`,
    `turn:${turnHost}:3478?transport=tcp`,
    `turns:${turnHost}:5349?transport=tcp`,
    ...(turnTls443 ? [`turns:${turnHost}:443?transport=tcp`] : []),
  ];

  if (stunUrl) iceServers.push({ urls: stunUrl });

  if (turnHost && turnSecret) {
    const expiry = Math.floor(Date.now() / 1000) + turnTtl;
    const username = `${expiry}:${userId}`;
    const credential = crypto
      .createHmac("sha1", turnSecret)
      .update(username)
      .digest("base64");
    iceServers.push({
      urls: turnUrls,
      username,
      credential,
    });
  } else if (turnHost && turnUsername && turnPassword) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnPassword,
    });
  }

  return iceServers;
}

function sendAck(ack: unknown, payload: object) {
  if (typeof ack === "function") (ack as (value: object) => void)(payload);
}

export async function registerP2PMeet(
  server: HttpServer,
  subscribeToAccountDisabled: AccountDisabledSubscriber = onMeetAccountDisabled,
) {
  const io = new SocketIOServer(server, {
    path: "/api/socket.io",
    serveClient: false,
    maxHttpBufferSize: 100_000,
    pingTimeout: 30_000,
    connectionStateRecovery: {
      maxDisconnectionDuration: RECOVERY_WINDOW_MS,
      skipMiddlewares: false,
    },
    cors: { origin: false },
  });
  const rooms = new Map<string, RoomState>();
  const joinAttempts = new Map<string, { count: number; firstAt: number }>();
  const pendingPeerRemoval = new Map<string, ReturnType<typeof setTimeout>>();
  const disconnectAccountSockets = (accountId: number) => {
    io.in(`meet-account:${accountId}`).disconnectSockets(true);
    logger.info(
      { accountId, event: "meet_account_sockets_disconnected" },
      "P2P Meet disconnected sockets for disabled account",
    );
  };
  const reconcileDisabledAccounts = async () => {
    const connectedAccountIds = Array.from(
      io.sockets.sockets.values(),
      (socket) => Number(socket.data.account?.id),
    ).filter((accountId) => Number.isInteger(accountId) && accountId > 0);
    const inactiveAccountIds = await inactiveMeetAccountIds([
      ...new Set(connectedAccountIds),
    ]);
    for (const accountId of inactiveAccountIds) disconnectAccountSockets(accountId);
  };
  const removeAccountDisabledListener = await subscribeToAccountDisabled(
    disconnectAccountSockets,
    reconcileDisabledAccounts,
    (error) => {
      logger.error(
        { err: error },
        "P2P Meet account deactivation subscription lost; reconnecting",
      );
    },
  );
  server.once("close", () => {
    void removeAccountDisabledListener();
  });

  const recoveryKey = (room: string, peerId: string) => `${room}:${peerId}`;

  const cancelPendingPeerRemoval = (room: string, peerId: string) => {
    const key = recoveryKey(room, peerId);
    const timer = pendingPeerRemoval.get(key);
    if (!timer) return;
    clearTimeout(timer);
    pendingPeerRemoval.delete(key);
  };

  const schedulePeerRemoval = (room: string, peerId: string) => {
    const key = recoveryKey(room, peerId);
    cancelPendingPeerRemoval(room, peerId);
    const timer = setTimeout(() => {
      pendingPeerRemoval.delete(key);
      const roomState = rooms.get(room);
      if (!roomState?.peers.has(peerId)) return;
      roomState.peers.delete(peerId);
      io.to(room).emit("peer-left", { id: peerId });
      if (roomState.peers.size === 0) rooms.delete(room);
      logger.info(
        { room, peerId, event: "meet_room_peer_expired" },
        "P2P Meet disconnected peer expired after recovery window",
      );
    }, RECOVERY_WINDOW_MS);
    timer.unref();
    pendingPeerRemoval.set(key, timer);
  };

  io.use(async (socket, next) => {
    if (!isMeetAuthRequired()) {
      next();
      return;
    }
    try {
      const account = await accountForSession(
        sessionTokenFromCookie(socket.handshake.headers.cookie),
      );
      if (!account) {
        next(new Error("Une session NovaLuth est requise pour Meet."));
        return;
      }
      socket.data.account = {
        id: account.id,
        login: account.login,
        displayName: account.displayName,
        role: account.role,
      };
      next();
    } catch (error) {
      logger.error({ err: error }, "P2P Meet session verification failed");
      next(new Error("La session NovaLuth n’a pas pu être vérifiée."));
    }
  });

  const joinAllowed = (key: string) => {
    const now = Date.now();
    const current = joinAttempts.get(key);
    return !current
      || now - current.firstAt > JOIN_WINDOW_MS
      || current.count < JOIN_ATTEMPT_LIMIT;
  };

  const registerFailedJoin = (key: string) => {
    const now = Date.now();
    const current = joinAttempts.get(key);
    if (!current || now - current.firstAt > JOIN_WINDOW_MS) {
      joinAttempts.set(key, { count: 1, firstAt: now });
      return;
    }
    current.count += 1;
  };

  io.on("connection", (socket: Socket) => {
    const accountId = Number(socket.data.account?.id);
    if (Number.isInteger(accountId) && accountId > 0) {
      void socket.join(`meet-account:${accountId}`);
    }
    let currentRoom: string | null =
      typeof socket.data.room === "string" ? socket.data.room : null;
    let currentPeerId: string | null =
      typeof socket.data.peerId === "string" ? socket.data.peerId : null;
    const forwardedFor = socket.handshake.headers["x-forwarded-for"];
    const address = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : forwardedFor?.split(",")[0]?.trim() || socket.handshake.address || "unknown";
    const ipHash = fingerprint(address);

    socket.on("join", (payload: RoomPayload = {}, ack?: unknown) => {
      const room = normalizeRoom(payload.room);
      const name =
        sanitize(payload.name, 24)
        || (isMeetAuthRequired() ? sanitize(socket.data.account?.displayName, 24) : "")
        || "Invité";
      const participantId = sanitize(payload.participantId, 80) || currentPeerId || socket.id;
      const code = String(payload.code ?? "");
      const roomPassword = String(payload.roomPassword ?? "").slice(0, 128);

      if (room.length < 2) {
        sendAck(ack, { ok: false, error: "Nom de salle invalide (2 caractères minimum)." });
        return;
      }
      if (!joinAllowed(ipHash)) {
        sendAck(ack, {
          ok: false,
          error: "Trop de tentatives. Réessayez dans quelques minutes.",
        });
        logger.warn({ room, ipHash, event: "meet_join_rate_limited" }, "P2P Meet access blocked");
        return;
      }
      if (ACCESS_CODE && code !== ACCESS_CODE) {
        registerFailedJoin(ipHash);
        sendAck(ack, { ok: false, error: "Code d'accès incorrect." });
        logger.warn({ room, ipHash, event: "meet_access_code_rejected" }, "P2P Meet access rejected");
        return;
      }

      let roomState = rooms.get(room);
      if (!roomState) {
        if (roomPassword && roomPassword.length < 8) {
          sendAck(ack, {
            ok: false,
            error: "Le mot de passe de salle doit contenir au moins 8 caractères.",
          });
          return;
        }
        const passwordSalt = roomPassword ? crypto.randomBytes(16).toString("hex") : null;
        roomState = {
          peers: new Map<string, RoomPeer>(),
          passwordSalt,
          passwordHash: passwordSalt ? hashRoomPassword(roomPassword, passwordSalt) : null,
        };
        rooms.set(room, roomState);
      } else if (roomState.passwordHash && !roomPasswordMatches(roomState, roomPassword)) {
        registerFailedJoin(ipHash);
        sendAck(ack, {
          ok: false,
          error: roomPassword
            ? "Mot de passe de salle incorrect."
            : "Cette salle est protégée. Saisissez son mot de passe.",
          needRoomPassword: true,
        });
        logger.warn({ room, ipHash, event: "meet_room_password_rejected" }, "P2P Meet room password rejected");
        return;
      }

      const recoveredPeer = roomState.peers.get(participantId);
      const connectedPeerCount = Array.from(roomState.peers.values())
        .filter((peer) => peer.connected)
        .length;
      if (!recoveredPeer && connectedPeerCount >= MAX_PEERS) {
        sendAck(ack, { ok: false, error: `Salle pleine (${MAX_PEERS} participants maximum).` });
        return;
      }

      currentRoom = room;
      currentPeerId = participantId;
      socket.data.name = name;
      socket.data.room = room;
      socket.data.peerId = participantId;
      socket.join(room);
      const existing = Array.from(roomState.peers, ([id, info]) => ({ id, name: info.name }))
        .filter(({ id }) => id !== participantId)
        .filter(({ id }) => roomState?.peers.get(id)?.connected);
      if (recoveredPeer) {
        cancelPendingPeerRemoval(room, participantId);
        recoveredPeer.name = name;
        recoveredPeer.socketId = socket.id;
        recoveredPeer.connected = true;
        socket.to(room).emit("peer-reconnected", { id: participantId, name });
      } else {
        roomState.peers.set(participantId, { name, socketId: socket.id, connected: true });
        socket.to(room).emit("peer-joined", { id: participantId, name });
      }
      sendAck(ack, {
        ok: true,
        selfId: participantId,
        room,
        protected: Boolean(roomState.passwordHash),
        peers: existing,
      });
      logger.info(
        { room, ipHash, peerCount: roomState.peers.size, event: "meet_room_joined" },
        "P2P Meet peer joined",
      );
    });

    socket.on("signal", ({ to, data }: SignalPayload = {}) => {
      if (!currentRoom || !currentPeerId || !to || !data) return;
      const roomState = rooms.get(currentRoom);
      const targetPeer = roomState?.peers.get(to);
      if (!targetPeer?.connected) return;
      io.to(targetPeer.socketId).emit("signal", {
        from: currentPeerId,
        name: socket.data.name,
        data,
      });
    });

    socket.on("chat", (payload: { text?: unknown } = {}) => {
      if (!currentRoom || !currentPeerId) return;
      const text = sanitize(payload.text, 800);
      if (!text) return;
      io.to(currentRoom).emit("chat", {
        from: currentPeerId,
        name: socket.data.name,
        text,
        at: Date.now(),
      });
    });

    socket.on("state", (state: { audio?: unknown; video?: unknown } = {}) => {
      if (!currentRoom || !currentPeerId) return;
      socket.to(currentRoom).emit("state", {
        from: currentPeerId,
        audio: Boolean(state.audio),
        video: Boolean(state.video),
      });
    });

    socket.on("disconnect", (reason) => {
      if (!currentRoom || !currentPeerId) return;
      const roomState = rooms.get(currentRoom);
      const peer = roomState?.peers.get(currentPeerId);
      if (!peer || peer.socketId !== socket.id) return;
      if (
        reason === "client namespace disconnect"
        || reason === "server namespace disconnect"
      ) {
        roomState?.peers.delete(currentPeerId);
        if (roomState?.peers.size === 0) rooms.delete(currentRoom);
        socket.to(currentRoom).emit("peer-left", { id: currentPeerId });
        logger.info(
          { room: currentRoom, ipHash, event: "meet_room_left" },
          "P2P Meet peer left",
        );
        return;
      }
      peer.connected = false;
      schedulePeerRemoval(currentRoom, currentPeerId);
      socket.to(currentRoom).emit("peer-disconnected", { id: currentPeerId });
      logger.info(
        {
          room: currentRoom,
          ipHash,
          recovered: socket.recovered,
          event: "meet_room_disconnected",
        },
        "P2P Meet peer disconnected; waiting for recovery",
      );
    });
  });

  const cleanupAttempts = setInterval(() => {
    const cutoff = Date.now() - JOIN_WINDOW_MS;
    joinAttempts.forEach((entry, key) => {
      if (entry.firstAt < cutoff) joinAttempts.delete(key);
    });
  }, JOIN_WINDOW_MS);
  cleanupAttempts.unref();

  return io;
}