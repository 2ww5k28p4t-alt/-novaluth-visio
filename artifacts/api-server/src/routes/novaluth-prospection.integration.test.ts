import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  novaluthPlatformAccountsTable,
  novaluthPlatformSessionsTable,
  novaluthProfilesTable,
  pool,
  prospectionDossiers,
  prospectionJournal,
  prospectionProposals,
} from "@workspace/db";
import app from "../app";

let server: Server;
let origin = "";
const suffix = randomUUID().slice(0, 10);
const slug = `prospection-${suffix}`;
const login = `prospection-admin-${suffix}`;
const adminToken = `prospection-token-${suffix}`;
let dossierId = "";
let accountId = 0;

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}

before(async () => {
  process.env.NOVALUTH_ADMIN_TOKEN = adminToken;
  process.env.NOVALUTH_PROSPECTION_HMAC_SECRET_V1 = `hmac-${suffix}`;
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (dossierId) {
    await db.delete(prospectionJournal).where(eq(prospectionJournal.dossierId, dossierId));
    await db.delete(prospectionProposals).where(eq(prospectionProposals.dossierId, dossierId));
    await db.delete(prospectionDossiers).where(eq(prospectionDossiers.id, dossierId));
  }
  if (accountId) {
    await db.delete(novaluthPlatformSessionsTable).where(eq(novaluthPlatformSessionsTable.accountId, accountId));
    await db.delete(novaluthPlatformAccountsTable).where(eq(novaluthPlatformAccountsTable.id, accountId));
  }
  await db.delete(novaluthProfilesTable).where(eq(novaluthProfilesTable.slug, slug));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test("la relecture lie le validateur serveur et ne permet jamais la livraison", async () => {
  const anonymous = await api("/admin/prospection/dossiers");
  assert.equal(anonymous.response.status, 401);

  const createdAccount = await api("/admin/meet/accounts", {
    method: "POST",
    headers: { "X-Admin-Token": adminToken },
    body: JSON.stringify({
      login,
      displayName: "Administrateur prospection",
      role: "admin",
      atelierSlug: null,
    }),
  });
  assert.equal(createdAccount.response.status, 201);
  accountId = Number(createdAccount.body?.account && (createdAccount.body.account as Record<string, unknown>).id);
  const password = String(createdAccount.body?.temporaryPassword);

  const loginResponse = await api("/meet/auth/login", {
    method: "POST",
    body: JSON.stringify({ login, password }),
  });
  assert.equal(loginResponse.response.status, 200);
  const cookie = loginResponse.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  await db.insert(novaluthProfilesTable).values({
    slug,
    name: "Atelier de test",
    entityType: "luthier",
    status: "candidate",
    data: { slug, nom: "Atelier de test" },
  });
  const openedAt = new Date();
  const [dossier] = await db.insert(prospectionDossiers).values({
    slug,
    workshopName: "Atelier de test",
    websiteUrl: "https://example.test",
    contactEmail: "contact@example.test",
    state: "verified",
    hook: "Accroche humaine suffisamment longue pour être relue et validée.",
    hookOrigin: "human",
    verifiedSignals: ["Indice public numéro un", "Indice public numéro deux"],
    openedAt,
    verifiedAt: openedAt,
  }).returning();
  dossierId = dossier.id;

  const subject = "Proposition de découverte NovaLuth";
  const body = "Bonjour, ".padEnd(220, "x");
  const validated = await api(`/admin/prospection/dossiers/${dossierId}/validate`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ revision: 0, subject, body, validatedByAccountId: 999999 }),
  });
  assert.equal(validated.response.status, 200);
  assert.equal((validated.body?.proposal as Record<string, unknown>).delivery_allowed, false);

  const [stored] = await db.select().from(prospectionProposals).where(eq(prospectionProposals.dossierId, dossierId));
  assert.equal(stored.validatedByAccountId, accountId);
  assert.equal(stored.deliveryAllowed, false);

  const withdrawn = await api(`/admin/prospection/dossiers/${dossierId}/withdraw`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ revision: 1, confirmed: true }),
  });
  assert.equal(withdrawn.response.status, 200);
  assert.equal(withdrawn.body?.proposal, null);
});