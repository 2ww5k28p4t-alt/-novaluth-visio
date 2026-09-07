import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import {
  db,
  novaluthPlatformAccountsTable,
  novaluthPlatformSessionsTable,
  novaluthProfilesTable,
  pool,
  prospectionDossiers,
  prospectionJournal,
  prospectionOppositions,
  prospectionProposals,
} from "@workspace/db";
import app from "../app";
import { setProspectionPageReaderForTest } from "../lib/novaluth-prospection";
import { PageReadRefused } from "../gateway/page-harvester";
import {
  PrepareProspectionDossierResponse,
} from "@workspace/api-zod";

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
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('novaluth.prospection_journal_test_cleanup', 'enabled', true)`);
      await tx.delete(prospectionJournal).where(eq(prospectionJournal.dossierId, dossierId));
    });
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
  const forbidden = await api("/admin/prospection/dossiers", {
    method: "POST", body: JSON.stringify({ slug }),
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body?.error, "admin_required");

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

  const existing = await api("/admin/prospection/dossiers", {
    method: "POST", headers: { cookie }, body: JSON.stringify({ slug }),
  });
  assert.equal(existing.response.status, 200);
  const missingProfile = await api("/admin/prospection/dossiers", {
    method: "POST", headers: { cookie }, body: JSON.stringify({ slug: `missing-${suffix}` }),
  });
  assert.equal(missingProfile.response.status, 404);
  assert.equal(missingProfile.body?.error, "not_found");
  const missingDossier = await api(`/admin/prospection/dossiers/${randomUUID()}/prepare`, {
    method: "POST", headers: { cookie }, body: JSON.stringify({ revision: 0 }),
  });
  assert.equal(missingDossier.response.status, 404);

  await db.update(prospectionDossiers).set({ state: "no_website", lastReason: "no_website" })
    .where(eq(prospectionDossiers.id, dossierId));
  const noWebsitePreparation = await api(`/admin/prospection/dossiers/${dossierId}/prepare`, {
    method: "POST", headers: { cookie }, body: JSON.stringify({ revision: 2 }),
  });
  assert.equal(noWebsitePreparation.response.status, 200);
  assert.equal(noWebsitePreparation.body?.state, "no_website");
  PrepareProspectionDossierResponse.parse(noWebsitePreparation.body);

  await db.update(prospectionDossiers).set({
    state: "opened", websiteUrl: "https://example.test", hook: null, hookOrigin: null,
    hookValidatedAt: null, hookValidatedByAccountId: null, lastReason: null, revision: 2,
  }).where(eq(prospectionDossiers.id, dossierId));
  setProspectionPageReaderForTest(async () => {
    throw new PageReadRefused("robots.txt interdit cette lecture");
  });
  const refusedPreparation = await api(`/admin/prospection/dossiers/${dossierId}/prepare`, {
    method: "POST", headers: { cookie }, body: JSON.stringify({ revision: 2 }),
  });
  assert.equal(refusedPreparation.response.status, 200);
  assert.equal(refusedPreparation.body?.reason, "read_refused");
  assert.equal(refusedPreparation.body?.retryable, false);
  assert.ok(String(refusedPreparation.body?.refusalMessage).length <= 300);
  PrepareProspectionDossierResponse.parse(refusedPreparation.body);
  await db.update(prospectionDossiers).set({
    state: "opened", lastReason: null, revision: 4,
  }).where(eq(prospectionDossiers.id, dossierId));
  setProspectionPageReaderForTest(async () => { throw new Error("unsafe upstream details"); });
  const retryablePreparation = await api(`/admin/prospection/dossiers/${dossierId}/prepare`, {
    method: "POST", headers: { cookie }, body: JSON.stringify({ revision: 4 }),
  });
  assert.equal(retryablePreparation.response.status, 200);
  assert.equal(retryablePreparation.body?.retryable, true);
  assert.notEqual(String(retryablePreparation.body?.refusalMessage).includes("unsafe"), true);
  PrepareProspectionDossierResponse.parse(retryablePreparation.body);
  setProspectionPageReaderForTest();

  await db.update(prospectionDossiers).set({
    state: "verified", hookOrigin: "ai", revision: 4,
    hook: "Accroche assistée suffisamment longue pour être explicitement relue.",
  }).where(eq(prospectionDossiers.id, dossierId));
  const incompleteHook = await api(`/admin/prospection/dossiers/${dossierId}/hook`, {
    method: "POST", headers: { cookie },
    body: JSON.stringify({ revision: 4, hook: "[À compléter : une phrase personnelle]" .padEnd(55, "x") }),
  });
  assert.equal(incompleteHook.response.status, 400);

  const lockClient = await pool.connect();
  try {
    await lockClient.query(
      "select pg_advisory_lock(hashtextextended($1, 0))",
      [`prospection:dossier:${dossierId}`],
    );
    const lockedHook = await api(`/admin/prospection/dossiers/${dossierId}/hook`, {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ revision: 4, hook: "Accroche humaine complète qui est suffisamment longue pour la validation." }),
    });
    assert.equal(lockedHook.response.status, 423);
    assert.equal(lockedHook.body?.error, "dossier_locked");
  } finally {
    await lockClient.query(
      "select pg_advisory_unlock(hashtextextended($1, 0))",
      [`prospection:dossier:${dossierId}`],
    );
    lockClient.release();
  }
  const hooked = await api(`/admin/prospection/dossiers/${dossierId}/hook`, {
    method: "POST", headers: { cookie },
    body: JSON.stringify({ revision: 4, hook: "Accroche humaine complète qui est suffisamment longue pour la validation." }),
  });
  assert.equal(hooked.response.status, 200);
  assert.equal(hooked.body?.hook_origin, "ai");

  const opposed = await api("/admin/prospection/oppositions", {
    method: "POST", headers: { cookie },
    body: JSON.stringify({ email: "contact@example.test", origin: "admin_entry" }),
  });
  assert.equal(opposed.response.status, 201);
  assert.equal(typeof opposed.body?.closedDossiers, "number");
  const [storedOpposition] = await db.select().from(prospectionDossiers)
    .where(eq(prospectionDossiers.id, dossierId));
  assert.equal(storedOpposition.state, "opposed");
  const [opposition] = await db.select().from(prospectionOppositions)
    .where(eq(prospectionOppositions.emailHmac, "contact@example.test"));
  assert.equal(opposition, undefined);
  const [hashedOpposition] = await db.select().from(prospectionOppositions);
  assert.ok(hashedOpposition.emailHmac);
  assert.equal("email" in hashedOpposition, false);
});