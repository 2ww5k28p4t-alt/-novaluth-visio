import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { lt } from "drizzle-orm";
import { db, novaluthGatewayNoncesTable } from "@workspace/db";

const MAX_CLOCK_SKEW_SECONDS = 120;

function gatewaySecret(): string {
  return process.env.NOVALUTH_GATEWAY_SECRET?.trim() ?? "";
}

export function gatewayIsConfigured(): boolean {
  return gatewaySecret().length >= 32;
}

export async function authenticateGatewayRequest(req: Request): Promise<{ caller: string; body: string }> {
  const secret = gatewaySecret();
  if (secret.length < 32) {
    throw new GatewayAuthError(503, "Passerelle non configurée.");
  }
  const timestamp = req.header("X-NovaLuth-Timestamp") ?? "";
  const nonce = req.header("X-NovaLuth-Nonce") ?? "";
  const signature = req.header("X-NovaLuth-Signature") ?? "";
  const now = Math.floor(Date.now() / 1000);
  const parsedTimestamp = Number(timestamp);
  if (
    !timestamp ||
    !nonce ||
    !/^[a-f0-9]{64}$/i.test(signature) ||
    !Number.isInteger(parsedTimestamp) ||
    Math.abs(now - parsedTimestamp) > MAX_CLOCK_SKEW_SECONDS
  ) {
    throw new GatewayAuthError(401, "Signature de passerelle invalide.");
  }
  const body =
    (req as Request & { rawBody?: Buffer }).rawBody?.toString("utf8") ??
    JSON.stringify(req.body ?? {});
  const expected = createHmac("sha256", secret)
    .update(`${req.method.toUpperCase()}.${req.originalUrl.split("?", 1)[0]}.${timestamp}.${nonce}.${body}`)
    .digest("hex");
  const receivedBytes = Buffer.from(signature, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (
    receivedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(receivedBytes, expectedBytes)
  ) {
    throw new GatewayAuthError(401, "Signature de passerelle invalide.");
  }
  const caller = (req.header("X-NovaLuth-Caller") ?? "service-interne")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
  const expiresAt = new Date((now + MAX_CLOCK_SKEW_SECONDS) * 1000);
  await db.delete(novaluthGatewayNoncesTable).where(lt(novaluthGatewayNoncesTable.expiresAt, new Date()));
  const recorded = await db
    .insert(novaluthGatewayNoncesTable)
    .values({ nonce, caller, expiresAt })
    .onConflictDoNothing()
    .returning({ nonce: novaluthGatewayNoncesTable.nonce });
  if (recorded.length !== 1) {
    throw new GatewayAuthError(401, "Requête de passerelle déjà utilisée.");
  }
  return { caller, body };
}

export class GatewayAuthError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
