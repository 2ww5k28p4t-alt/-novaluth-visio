import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  novaluthPlatformAccountsTable,
  novaluthPlatformSessionsTable,
  pool,
} from "@workspace/db";
import app from "../app";
import { registerP2PMeet } from "../lib/p2p-meet";
import { onMeetAccountDisabled } from "../lib/p2p-meet-auth";

type JsonBody = Record<string, unknown>;

let server: Server;
let origin = "";
let closeSocketServer: (() => Promise<void>) | null = null;
let reconcileDisabledAccounts: (() => Promise<void>) | null = null;

const suffix = randomUUID().slice(0, 12);
const login = `meet-${suffix}`;
const observerLogin = `meet-observer-${suffix}`;
const reconciliationLogin = `meet-reconcile-${suffix}`;
const adminToken = `admin-${suffix}`;
const originalEnvironment = {
  authRequired: process.env.NOVALUTH_MEET_AUTH_REQUIRED,
  adminToken: process.env.NOVALUTH_ADMIN_TOKEN,
};

async function api(
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: JsonBody | null }> {
  const response = await fetch(`${origin}/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) as JsonBody : null,
  };
}

function sessionCookie(response: Response) {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie?.startsWith("novaluth_meet_session="), "la session Meet doit poser un cookie");
  return cookie;
}

async function openSocketIoSession(cookie?: string) {
  const query = new URLSearchParams({
    EIO: "4",
    transport: "polling",
    t: randomUUID(),
  });
  const headers = cookie ? { cookie } : undefined;
  const opened = await fetch(`${origin}/api/socket.io/?${query}`, { headers });
  assert.equal(opened.status, 200);
  const openPacket = await opened.text();
  assert.ok(openPacket.startsWith("0"), `paquet Engine.IO inattendu : ${openPacket}`);
  const openPayload = JSON.parse(openPacket.slice(1)) as { sid?: string };
  assert.ok(openPayload.sid);

  query.set("sid", openPayload.sid);
  query.set("t", randomUUID());
  const connected = await fetch(`${origin}/api/socket.io/?${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      ...(headers ?? {}),
    },
    body: "40",
  });
  assert.equal(connected.status, 200);

  query.set("t", randomUUID());
  const polled = await fetch(`${origin}/api/socket.io/?${query}`, { headers });
  assert.equal(polled.status, 200);
  const connectPacket = await polled.text();
  return {
    connectPacket,
    async emit(event: string, payload: object) {
      query.set("t", randomUUID());
      const response = await fetch(`${origin}/api/socket.io/?${query}`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          ...(headers ?? {}),
        },
        body: `42${JSON.stringify([event, payload])}`,
      });
      assert.equal(response.status, 200);
    },
    async poll() {
      query.set("t", randomUUID());
      const response = await fetch(`${origin}/api/socket.io/?${query}`, { headers });
      const body = await response.text();
      return { status: response.status, body };
    },
  };
}

async function socketIoConnectPacket(cookie?: string) {
  return (await openSocketIoSession(cookie)).connectPacket;
}

before(async () => {
  process.env.NOVALUTH_MEET_AUTH_REQUIRED = "true";
  process.env.NOVALUTH_ADMIN_TOKEN = adminToken;

  server = createServer(app);
  let allowSubscription!: () => void;
  const subscriptionGate = new Promise<void>((resolve) => {
    allowSubscription = resolve;
  });
  let registrationSettled = false;
  const registration = registerP2PMeet(
    server,
    async (listener, reconcile, onError) => {
      reconcileDisabledAccounts = reconcile;
      await subscriptionGate;
      return onMeetAccountDisabled(listener, reconcile, onError);
    },
  ).finally(() => {
    registrationSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    registrationSettled,
    false,
    "Meet ne doit pas devenir prêt avant son abonnement aux révocations",
  );
  allowSubscription();
  const io = await registration;
  closeSocketServer = () =>
    new Promise<void>((resolve) => {
      io.close(() => resolve());
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  const accounts = await db
    .select({ id: novaluthPlatformAccountsTable.id })
    .from(novaluthPlatformAccountsTable)
    .where(
      inArray(novaluthPlatformAccountsTable.login, [
        login,
        observerLogin,
        reconciliationLogin,
      ]),
    );
  for (const account of accounts) {
    await db
      .delete(novaluthPlatformSessionsTable)
      .where(eq(novaluthPlatformSessionsTable.accountId, account.id));
    await db
      .delete(novaluthPlatformAccountsTable)
      .where(eq(novaluthPlatformAccountsTable.id, account.id));
  }
  await closeSocketServer?.();
  if (originalEnvironment.authRequired === undefined) {
    delete process.env.NOVALUTH_MEET_AUTH_REQUIRED;
  } else {
    process.env.NOVALUTH_MEET_AUTH_REQUIRED = originalEnvironment.authRequired;
  }
  if (originalEnvironment.adminToken === undefined) {
    delete process.env.NOVALUTH_ADMIN_TOKEN;
  } else {
    process.env.NOVALUTH_ADMIN_TOKEN = originalEnvironment.adminToken;
  }
  await pool.end();
});

test("Meet protège durablement les comptes, ICE et Socket.IO", async () => {
  const anonymousIce = await api("/meet/ice");
  assert.equal(anonymousIce.response.status, 401);
  assert.match(String(anonymousIce.body?.error), /session NovaLuth/i);

  const anonymousSocket = await socketIoConnectPacket();
  assert.match(anonymousSocket, /^44/);
  assert.match(anonymousSocket, /session NovaLuth/i);

  const created = await api("/admin/meet/accounts", {
    method: "POST",
    headers: { "X-Admin-Token": adminToken },
    body: JSON.stringify({
      login,
      displayName: "Compte Meet test",
      role: "musicien",
    }),
  });
  assert.equal(created.response.status, 201);
  const account = created.body?.account as JsonBody;
  const accountId = Number(account.id);
  const firstPassword = String(created.body?.temporaryPassword);
  assert.ok(Number.isInteger(accountId) && accountId > 0);
  assert.ok(firstPassword.length >= 12);

  const loggedIn = await api("/meet/auth/login", {
    method: "POST",
    body: JSON.stringify({ login, password: firstPassword }),
  });
  assert.equal(loggedIn.response.status, 200);
  const firstCookie = sessionCookie(loggedIn.response);

  const session = await api("/meet/auth/session", {
    headers: { cookie: firstCookie },
  });
  assert.equal(session.response.status, 200);
  assert.equal(session.body?.authenticated, true);

  const authenticatedIce = await api("/meet/ice", {
    headers: { cookie: firstCookie },
  });
  assert.equal(authenticatedIce.response.status, 200);

  const authenticatedSocket = await socketIoConnectPacket(firstCookie);
  assert.match(authenticatedSocket, /^40/);
  assert.doesNotMatch(authenticatedSocket, /^44/);

  const loggedOut = await api("/meet/auth/logout", {
    method: "POST",
    headers: { cookie: firstCookie },
  });
  assert.equal(loggedOut.response.status, 204);
  const loggedOutSession = await api("/meet/auth/session", {
    headers: { cookie: firstCookie },
  });
  assert.equal(loggedOutSession.body?.authenticated, false);

  const loggedInAgain = await api("/meet/auth/login", {
    method: "POST",
    body: JSON.stringify({ login, password: firstPassword }),
  });
  assert.equal(loggedInAgain.response.status, 200);
  const preResetCookie = sessionCookie(loggedInAgain.response);

  const reset = await api(`/admin/meet/accounts/${accountId}/reset-password`, {
    method: "POST",
    headers: { "X-Admin-Token": adminToken },
  });
  assert.equal(reset.response.status, 200);
  const resetPassword = String(reset.body?.temporaryPassword);
  assert.ok(resetPassword.length >= 12);
  assert.notEqual(resetPassword, firstPassword);

  const resetRevokedSession = await api("/meet/auth/session", {
    headers: { cookie: preResetCookie },
  });
  assert.equal(resetRevokedSession.body?.authenticated, false);
  const oldPasswordRejected = await api("/meet/auth/login", {
    method: "POST",
    body: JSON.stringify({ login, password: firstPassword }),
  });
  assert.equal(oldPasswordRejected.response.status, 401);

  const resetLogin = await api("/meet/auth/login", {
    method: "POST",
    body: JSON.stringify({ login, password: resetPassword }),
  });
  assert.equal(resetLogin.response.status, 200);
  const activeCookie = sessionCookie(resetLogin.response);

  const observerCreated = await api("/admin/meet/accounts", {
    method: "POST",
    headers: { "X-Admin-Token": adminToken },
    body: JSON.stringify({
      login: observerLogin,
      displayName: "Observateur Meet test",
      role: "musicien",
    }),
  });
  assert.equal(observerCreated.response.status, 201);
  const observerLoginResponse = await api("/meet/auth/login", {
    method: "POST",
    body: JSON.stringify({
      login: observerLogin,
      password: String(observerCreated.body?.temporaryPassword),
    }),
  });
  assert.equal(observerLoginResponse.response.status, 200);
  const observerCookie = sessionCookie(observerLoginResponse.response);
  const observerSocket = await openSocketIoSession(observerCookie);
  const activeSocket = await openSocketIoSession(activeCookie);
  assert.match(observerSocket.connectPacket, /^40/);
  assert.match(activeSocket.connectPacket, /^40/);
  await observerSocket.emit("join", {
    room: `disabled-${suffix}`,
    name: "Observateur",
    participantId: "observer",
  });
  await activeSocket.emit("join", {
    room: `disabled-${suffix}`,
    name: "Compte désactivé",
    participantId: "disabled-account",
  });
  const joinedEvent = await observerSocket.poll();
  assert.equal(joinedEvent.status, 200);
  assert.match(joinedEvent.body, /peer-joined/);
  const activeDisconnect = activeSocket.poll();
  const observerDeparture = observerSocket.poll();

  const disabled = await api(`/admin/meet/accounts/${accountId}`, {
    method: "PATCH",
    headers: { "X-Admin-Token": adminToken },
    body: JSON.stringify({ active: false }),
  });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.body?.active, false);
  const disconnected = await activeDisconnect;
  assert.match(disconnected.body, /(?:^|\x1e)(?:1|41)/);
  const departure = await observerDeparture;
  assert.equal(departure.status, 200);
  assert.match(departure.body, /peer-left/);
  assert.match(departure.body, /disabled-account/);

  const reconciliationCreated = await api("/admin/meet/accounts", {
    method: "POST",
    headers: { "X-Admin-Token": adminToken },
    body: JSON.stringify({
      login: reconciliationLogin,
      displayName: "Réconciliation Meet test",
      role: "musicien",
    }),
  });
  assert.equal(reconciliationCreated.response.status, 201);
  const reconciliationAccount = reconciliationCreated.body?.account as JsonBody;
  const reconciliationAccountId = Number(reconciliationAccount.id);
  const reconciliationLoginResponse = await api("/meet/auth/login", {
    method: "POST",
    body: JSON.stringify({
      login: reconciliationLogin,
      password: String(reconciliationCreated.body?.temporaryPassword),
    }),
  });
  assert.equal(reconciliationLoginResponse.response.status, 200);
  const reconciliationCookie = sessionCookie(reconciliationLoginResponse.response);
  const reconciliationSocket = await openSocketIoSession(reconciliationCookie);
  assert.match(reconciliationSocket.connectPacket, /^40/);
  await db
    .update(novaluthPlatformAccountsTable)
    .set({ active: false })
    .where(eq(novaluthPlatformAccountsTable.id, reconciliationAccountId));
  const reconciledDisconnect = reconciliationSocket.poll();
  assert.ok(reconcileDisabledAccounts);
  await reconcileDisabledAccounts();
  assert.match((await reconciledDisconnect).body, /(?:^|\x1e)(?:1|41)/);

  const disabledSession = await api("/meet/auth/session", {
    headers: { cookie: activeCookie },
  });
  assert.equal(disabledSession.body?.authenticated, false);
  const disabledIce = await api("/meet/ice", {
    headers: { cookie: activeCookie },
  });
  assert.equal(disabledIce.response.status, 401);
  const disabledSocket = await socketIoConnectPacket(activeCookie);
  assert.match(disabledSocket, /^44/);
  assert.match(disabledSocket, /session NovaLuth/i);

  const disabledLogin = await api("/meet/auth/login", {
    method: "POST",
    body: JSON.stringify({ login, password: resetPassword }),
  });
  assert.equal(disabledLogin.response.status, 401);
});