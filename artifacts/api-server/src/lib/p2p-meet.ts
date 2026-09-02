import crypto from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { logger } from "./logger";

const MAX_PEERS = Math.max(2, Number(process.env.MAX_PEERS_PER_ROOM ?? 8));
const ACCESS_CODE = process.env.ACCESS_CODE ?? "";

type RoomPeer = { name: string };
type SignalPayload = { to?: string; data?: unknown };
type RoomPayload = { room?: unknown; name?: unknown; code?: unknown };

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
    serveClient: true,
    maxHttpBufferSize: 100_000,
    pingTimeout: 30_000,
    cors: { origin: false },
  });
  const rooms = new Map<string, Map<string, RoomPeer>>();

  io.on("connection", (socket: Socket) => {
    let currentRoom: string | null = null;

    socket.on("join", (payload: RoomPayload = {}, ack?: unknown) => {
      const room = normalizeRoom(payload.room);
      const name = sanitize(payload.name, 24) || "Invité";
      const code = String(payload.code ?? "");

      if (room.length < 2) {
        sendAck(ack, { ok: false, error: "Nom de salle invalide (2 caractères minimum)." });
        return;
      }
      if (ACCESS_CODE && code !== ACCESS_CODE) {
        sendAck(ack, { ok: false, error: "Code d'accès incorrect." });
        return;
      }

      const peers = rooms.get(room) ?? new Map<string, RoomPeer>();
      if (peers.size >= MAX_PEERS) {
        sendAck(ack, { ok: false, error: `Salle pleine (${MAX_PEERS} participants maximum).` });
        return;
      }

      currentRoom = room;
      socket.data.name = name;
      socket.join(room);
      rooms.set(room, peers);
      const existing = Array.from(peers, ([id, info]) => ({ id, name: info.name }));
      peers.set(socket.id, { name });
      socket.to(room).emit("peer-joined", { id: socket.id, name });
      sendAck(ack, { ok: true, selfId: socket.id, room, peers: existing });
      logger.info({ room, socketId: socket.id, peerCount: peers.size }, "P2P Meet peer joined");
    });

    socket.on("signal", ({ to, data }: SignalPayload = {}) => {
      if (!currentRoom || !to || !data) return;
      const peers = rooms.get(currentRoom);
      if (!peers?.has(to)) return;
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
      const peers = rooms.get(currentRoom);
      peers?.delete(socket.id);
      if (peers?.size === 0) rooms.delete(currentRoom);
      socket.to(currentRoom).emit("peer-left", { id: socket.id });
      logger.info({ room: currentRoom, socketId: socket.id }, "P2P Meet peer left");
    });
  });

  return io;
}