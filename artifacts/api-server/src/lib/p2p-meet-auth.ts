import crypto from "node:crypto";
import {
  and,
  eq,
  gt,
  sql,
} from "drizzle-orm";
import {
  db,
  novaluthPlatformAccountsTable,
  novaluthPlatformSessionsTable,
  type NovaluthPlatformAccount,
} from "@workspace/db";

export const MEET_SESSION_COOKIE = "novaluth_meet_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 12;
const PASSWORD_HASH_PREFIX = "scrypt";

export type PublicMeetAccount = {
  id: number;
  login: string;
  displayName: string;
  role: string;
  atelierSlug: string | null;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
};

export function isMeetAuthRequired() {
  return String(
    process.env.NOVALUTH_MEET_AUTH_REQUIRED
      ?? process.env.MEET_AUTH_REQUIRED
      ?? (process.env.NODE_ENV === "production" ? "true" : "false"),
  ).toLowerCase() === "true";
}

function normalizeLogin(login: unknown) {
  return String(login ?? "").trim().toLowerCase().slice(0, 80);
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const digest = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${PASSWORD_HASH_PREFIX}$${salt}$${digest}`;
}

function passwordMatches(password: string, encoded: string) {
  const [prefix, salt, expectedHex] = encoded.split("$");
  if (prefix !== PASSWORD_HASH_PREFIX || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const candidate = crypto.scryptSync(password, salt, expected.length);
  return expected.length > 0
    && expected.length === candidate.length
    && crypto.timingSafeEqual(candidate, expected);
}

function publicAccount(account: NovaluthPlatformAccount): PublicMeetAccount {
  return {
    id: account.id,
    login: account.login,
    displayName: account.displayName,
    role: account.role,
    atelierSlug: account.atelierSlug,
    active: account.active,
    mustChangePassword: account.mustChangePassword,
    createdAt: account.createdAt.toISOString(),
    lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
  };
}

function newTemporaryPassword() {
  return crypto.randomBytes(18).toString("base64url");
}

function hashSessionToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function cookieIsSecure(req: { headers: Record<string, string | string[] | undefined> }) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return process.env.NODE_ENV === "production" || protocol === "https";
}

export function sessionCookie(token: string, secure: boolean) {
  return [
    `${MEET_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function expiredSessionCookie(secure: boolean) {
  return [
    `${MEET_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function sessionTokenFromCookie(header: string | undefined) {
  for (const part of String(header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== MEET_SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function accountForSession(token: string | null | undefined) {
  if (!token) return null;
  const [row] = await db
    .select({ account: novaluthPlatformAccountsTable })
    .from(novaluthPlatformSessionsTable)
    .innerJoin(
      novaluthPlatformAccountsTable,
      eq(
        novaluthPlatformSessionsTable.accountId,
        novaluthPlatformAccountsTable.id,
      ),
    )
    .where(
      and(
        eq(novaluthPlatformSessionsTable.tokenHash, hashSessionToken(token)),
        gt(novaluthPlatformSessionsTable.expiresAt, new Date()),
        eq(novaluthPlatformAccountsTable.active, true),
      ),
    )
    .limit(1);

  if (!row) return null;
  await db
    .update(novaluthPlatformSessionsTable)
    .set({ lastSeenAt: new Date() })
    .where(eq(novaluthPlatformSessionsTable.tokenHash, hashSessionToken(token)));
  return row.account;
}

export async function loginMeetAccount(login: unknown, password: unknown) {
  const normalized = normalizeLogin(login);
  const secret = String(password ?? "");
  const [account] = normalized
    ? await db
        .select()
        .from(novaluthPlatformAccountsTable)
        .where(sql`lower(${novaluthPlatformAccountsTable.login}) = ${normalized}`)
        .limit(1)
    : [];

  if (!account || !account.active) {
    return { ok: false as const, error: "Identifiant ou mot de passe incorrect." };
  }
  if (account.lockedUntil && account.lockedUntil > new Date()) {
    return {
      ok: false as const,
      error: "Compte temporairement verrouillé. Réessayez plus tard.",
    };
  }
  if (!passwordMatches(secret, account.passwordHash)) {
    const failedAttempts = account.failedAttempts + 1;
    await db
      .update(novaluthPlatformAccountsTable)
      .set({
        failedAttempts: failedAttempts >= 5 ? 0 : failedAttempts,
        lockedUntil:
          failedAttempts >= 5
            ? new Date(Date.now() + 15 * 60 * 1000)
            : null,
      })
      .where(eq(novaluthPlatformAccountsTable.id, account.id));
    return { ok: false as const, error: "Identifiant ou mot de passe incorrect." };
  }

  const [updated] = await db
    .update(novaluthPlatformAccountsTable)
    .set({
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    })
    .where(eq(novaluthPlatformAccountsTable.id, account.id))
    .returning();
  return { ok: true as const, account: updated ?? account };
}

export async function createMeetAccount(input: {
  login: string;
  displayName: string;
  role: string;
  atelierSlug?: string | null;
}) {
  const temporaryPassword = newTemporaryPassword();
  const [account] = await db
    .insert(novaluthPlatformAccountsTable)
    .values({
      login: normalizeLogin(input.login),
      displayName: input.displayName.trim().slice(0, 80),
      role: input.role,
      atelierSlug: input.atelierSlug || null,
      passwordHash: hashPassword(temporaryPassword),
      mustChangePassword: true,
    })
    .returning();
  return { account, temporaryPassword };
}

export async function resetMeetAccountPassword(accountId: number) {
  const temporaryPassword = newTemporaryPassword();
  const [account] = await db
    .update(novaluthPlatformAccountsTable)
    .set({
      passwordHash: hashPassword(temporaryPassword),
      mustChangePassword: true,
      failedAttempts: 0,
      lockedUntil: null,
    })
    .where(eq(novaluthPlatformAccountsTable.id, accountId))
    .returning();
  if (account) {
    await db
      .delete(novaluthPlatformSessionsTable)
      .where(eq(novaluthPlatformSessionsTable.accountId, accountId));
  }
  return account ? { account, temporaryPassword } : null;
}

export async function setMeetAccountActive(accountId: number, active: boolean) {
  const [account] = await db
    .update(novaluthPlatformAccountsTable)
    .set({ active })
    .where(eq(novaluthPlatformAccountsTable.id, accountId))
    .returning();
  if (account && !active) {
    await db
      .delete(novaluthPlatformSessionsTable)
      .where(eq(novaluthPlatformSessionsTable.accountId, accountId));
  }
  return account ?? null;
}

export async function createMeetSession(accountId: number) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(novaluthPlatformSessionsTable).values({
    tokenHash: hashSessionToken(token),
    accountId,
    expiresAt,
  });
  return { token, expiresAt };
}

export async function deleteMeetSession(token: string | null | undefined) {
  if (!token) return;
  await db
    .delete(novaluthPlatformSessionsTable)
    .where(eq(novaluthPlatformSessionsTable.tokenHash, hashSessionToken(token)));
}

export function accountToPublic(account: NovaluthPlatformAccount) {
  return publicAccount(account);
}

export function validateMeetAccountInput(input: {
  login: string;
  displayName: string;
  role: string;
}) {
  const login = normalizeLogin(input.login);
  if (login.length < 3 || !/^[a-z0-9._@-]+$/.test(login)) {
    return "L’identifiant doit contenir au moins 3 caractères et utiliser uniquement lettres, chiffres, point, tiret, underscore ou arobase.";
  }
  if (!input.displayName.trim()) return "Le nom affiché est obligatoire.";
  if (!["admin", "artisan", "musicien"].includes(input.role)) {
    return "Le rôle doit être administrateur, artisan ou musicien.";
  }
  return null;
}

export function passwordPolicyMessage() {
  return `Le mot de passe temporaire doit être remplacé par un mot de passe d’au moins ${MIN_PASSWORD_LENGTH} caractères.`;
}

export { MIN_PASSWORD_LENGTH };