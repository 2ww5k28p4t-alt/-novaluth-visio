import crypto from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { logger } from "./logger";

const MAX_PEERS = Math.max(2, Number(process.env.MAX_PEERS_PER_ROOM ?? 8));
const ACCESS_CODE = process.env.ACCESS_CODE ?? "";
const LOG_SALT = process.env.LOG_SALT ?? process.env.SESSION_SECRET ?? "novaluth-meet";
const JOIN_WINDOW_MS = 15 * 60 * 1000;
const JOIN_ATTEMPT_LIMIT = 15;

type RoomPeer = { name: string };
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
};

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
  const turnSecret = process.env.TURN_STATIC_AUTH_SECRET ?? "";
  const turnUsername = process.env.TURN_USERNAME ?? "";
  const turnPassword = process.env.TURN_PASSWORD ?? "";
  const turnTtl = Math.max(60, Number(process.env.TURN_TTL ?? 43200));
  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [];

  if (stunUrl) iceServers.push({ urls: stunUrl });

  if (turnHost && turnSecret) {
    const expiry = Math.floor(Date.now() / 1000) + turnTtl;
    const username = `${expiry}:${userId}`;
    const credential = crypto
      .createHmac("sha1", turnSecret)
      .update(username)
      .digest("base64");
    iceServers.push({
      urls: [
        `turn:${turnHost}:3478?transport=udp`,
        `turn:${turnHost}:3478?transport=tcp`,
        `turns:${turnHost}:5349?transport=tcp`,
        `turns:${turnHost}:443?transport=tcp`,
      ],
      username,
      credential,
    });
  } else if (turnHost && turnUsername && turnPassword) {
    iceServers.push({
      urls: [
        `turn:${turnHost}:3478?transport=udp`,
        `turn:${turnHost}:3478?transport=tcp`,
        `turns:${turnHost}:5349?transport=tcp`,
        `turns:${turnHost}:443?transport=tcp`,
      ],
      username: turnUsername,
      credential: turnPassword,
    });
  }

  return iceServers;
}

function sendAck(ack: unknown, payload: object) {
  if (typeof ack === "function") (ack as (value: object) => void)(payload);
}

export function registerP2PMeet(server: HttpServer) {
  const io = new SocketIOServer(server, {
    path: "/api/socket.io",
    serveClient: false,
    maxHttpBufferSize: 100_000,
    pingTimeout: 30_000,
    cors: { origin: false },
  });
  const rooms = new Map<string, RoomState>();
  const joinAttempts = new Map<string, { count: number; firstAt: number }>();

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
    let currentRoom: string | null = null;
    const forwardedFor = socket.handshake.headers["x-forwarded-for"];
    const address = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : forwardedFor?.split(",")[0]?.trim() || socket.handshake.address || "unknown";
    const ipHash = fingerprint(address);

    socket.on("join", (payload: RoomPayload = {}, ack?: unknown) => {
      const room = normalizeRoom(payload.room);
      const name = sanitize(payload.name, 24) || "Invité";
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

      if (roomState.peers.size >= MAX_PEERS) {
        sendAck(ack, { ok: false, error: `Salle pleine (${MAX_PEERS} participants maximum).` });
        return;
      }

      currentRoom = room;
      socket.data.name = name;
      socket.join(room);
      const existing = Array.from(roomState.peers, ([id, info]) => ({ id, name: info.name }));
      roomState.peers.set(socket.id, { name });
      socket.to(room).emit("peer-joined", { id: socket.id, name });
      sendAck(ack, {
        ok: true,
        selfId: socket.id,
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
      if (!currentRoom || !to || !data) return;
      const roomState = rooms.get(currentRoom);
      if (!roomState?.peers.has(to)) return;
      io.to(to).emit("signal", { from: socket.id, name: socket.data.name, data });
    });

    socket.on("chat", (payload: { text?: unknown } = {}) => {
      if (!currentRoom) return;
      const text = sanitize(payload.text, 800);
      if (!text) return;
      io.to(currentRoom).emit("chat", {
        from: socket.id,
        name: socket.data.name,
        text,
        at: Date.now(),
      });
    });

    socket.on("state", (state: { audio?: unknown; video?: unknown } = {}) => {
      if (!currentRoom) return;
      socket.to(currentRoom).emit("state", {
        from: socket.id,
        audio: Boolean(state.audio),
        video: Boolean(state.video),
      });
    });

    socket.on("disconnect", () => {
      if (!currentRoom) return;
      const roomState = rooms.get(currentRoom);
      roomState?.peers.delete(socket.id);
      if (roomState?.peers.size === 0) rooms.delete(currentRoom);
      socket.to(currentRoom).emit("peer-left", { id: socket.id });
      logger.info(
        { room: currentRoom, ipHash, event: "meet_room_left" },
        "P2P Meet peer left",
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