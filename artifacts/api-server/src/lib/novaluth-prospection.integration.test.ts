import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  novaluthPlatformAccountsTable,
  novaluthProfilesTable,
  pool,
  prospectionDossiers,
  prospectionJournal,
  prospectionOppositions,
  prospectionProposals,
} from "@workspace/db";
import {
  openProspectionDossier,
  correctProspectionDossier,
  prospectionEmailHmac,
  recordProspectionOpposition,
  recordProspectionOppositionForEmail,
  transitionProspectionDossier,
  validateAndQueueProspectionProposal,
  verifyProspectionDossier,
} from "./novaluth-prospection";

const suffix = randomUUID().slice(0, 10);
const slugs = [`course-${suffix}`, `opposition-${suffix}`, `transition-${suffix}`, `correction-${suffix}`, `verify-${suffix}`];
const email = `Contact.${suffix}@Example.test`;
let accountId = 0;
const dossierIds: string[] = [];
const extraAccountIds: number[] = [];
const additionalSlugs: string[] = [];

before(async () => {
  process.env.NOVALUTH_PROSPECTION_HMAC_SECRET_V1 = `prospection-${suffix}`;
  await db.insert(novaluthProfilesTable).values(
    slugs.map((slug) => ({
      slug,
      name: `Atelier ${slug}`,
      entityType: "luthier",
      status: "candidate",
      data: { slug, nom: `Atelier ${slug}` },
    })),
  );
  const [account] = await db.insert(novaluthPlatformAccountsTable).values({
    login: `prospection-service-${suffix}`,
    displayName: "Administrateur de test",
    role: "admin",
    passwordHash: "test-only",
    active: true,
  }).returning({ id: novaluthPlatformAccountsTable.id });
  accountId = account.id;
});

after(async () => {
  if (dossierIds.length) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('novaluth.prospection_journal_test_cleanup', 'enabled', true)`);
      await tx.delete(prospectionJournal).where(inArray(prospectionJournal.dossierId, dossierIds));
    });
    await db.delete(prospectionProposals).where(inArray(prospectionProposals.dossierId, dossierIds));
    await db.delete(prospectionDossiers).where(inArray(prospectionDossiers.id, dossierIds));
  }
  await db.delete(prospectionOppositions).where(eq(prospectionOppositions.emailHmac, prospectionEmailHmac(email)));
  if (accountId) {
    await db.delete(novaluthPlatformAccountsTable).where(eq(novaluthPlatformAccountsTable.id, accountId));
  }
  if (extraAccountIds.length) {
    await db.delete(novaluthPlatformAccountsTable).where(inArray(novaluthPlatformAccountsTable.id, extraAccountIds));
  }
  await db.delete(novaluthProfilesTable).where(inArray(novaluthProfilesTable.slug, [...slugs, ...additionalSlugs]));
  await pool.end();
});

test("une seule ouverture gagne pour un atelier", async () => {
  const request = {
    adminAccountId: accountId,
    slug: slugs[0],
    workshopName: "Atelier Course Unique",
    websiteUrl: "https://example.test",
    contactEmail: email,
  };
  const results = await Promise.all([
    openProspectionDossier(request),
    openProspectionDossier(request),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 2);
  const outcomes = results.filter((result) => result.ok);
  assert.equal(outcomes.filter((result) => result.value.created).length, 1);
  assert.equal(outcomes.filter((result) => !result.value.created).length, 1);
  assert.equal(new Set(outcomes.map((result) => result.value.id)).size, 1);
  dossierIds.push(outcomes[0].value.id);
  const journal = await db.select().from(prospectionJournal)
    .where(eq(prospectionJournal.dossierId, outcomes[0].value.id));
  assert.equal(journal.filter((entry) => entry.event === "dossier_opened").length, 1);
});

test("la vérification lit par la frontière injectée et les validations concurrentes échouent proprement", async () => {
  const verified = await verifyProspectionDossier(
    { adminAccountId: accountId, dossierId: dossierIds[0], revision: 0 },
    async () => ({
      url: "https://example.test",
      url_finale: "https://example.test",
      titre: "Atelier Course Unique",
      texte: "Atelier Course Unique fabrique et restaure des instruments sur mesure avec un savoir-faire documenté.",
      octets: 120,
      delai_respecte_s: 1.5,
    }),
  );
  assert.ok(verified.ok);
  assert.equal(verified.value.state, "verified");

  const proposal = {
    adminAccountId: accountId,
    dossierId: dossierIds[0],
    revision: verified.value.revision,
    subject: "Découvrir la sélection professionnelle NovaLuth",
    body: "Bonjour, ".padEnd(240, "x"),
  };
  const results = await Promise.all([
    validateAndQueueProspectionProposal(proposal),
    validateAndQueueProspectionProposal(proposal),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reason === "conflict").length, 1);
  const [stored] = await db.select().from(prospectionProposals).where(eq(prospectionProposals.dossierId, dossierIds[0]));
  assert.equal(stored.deliveryAllowed, false);
  assert.equal(stored.recipientHmac, prospectionEmailHmac(email));
  assert.equal(stored.recipientHmacVersion, 1);
});

test("une opposition est atomique, durable et bloque une nouvelle ouverture", async () => {
  const [current] = await db.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, dossierIds[0]));
  const stale = await recordProspectionOpposition({
    adminAccountId: accountId, dossierId: current.id, revision: current.revision - 1, origin: "admin_entry",
  });
  assert.deepEqual(stale, { ok: false, reason: "conflict" });
  const [beforeProposal] = await db.select().from(prospectionProposals).where(eq(prospectionProposals.dossierId, current.id));
  assert.equal(beforeProposal.withdrawnAt, null);
  const beforeOppositions = await db.select().from(prospectionOppositions)
    .where(eq(prospectionOppositions.emailHmac, prospectionEmailHmac(email)));
  assert.equal(beforeOppositions.length, 0);
  const journalBefore = await db.select().from(prospectionJournal).where(eq(prospectionJournal.dossierId, current.id));
  const opposed = await recordProspectionOpposition({
    adminAccountId: accountId,
    dossierId: current.id,
    revision: current.revision,
    origin: "admin_entry",
  });
  assert.ok(opposed.ok);
  assert.equal(opposed.value.state, "opposed");

  const blocked = await openProspectionDossier({
    adminAccountId: accountId,
    slug: slugs[1],
    workshopName: "Autre fiche du même contact",
    websiteUrl: "https://example.test",
    contactEmail: email.toLowerCase(),
  });
  assert.deepEqual(blocked, { ok: false, reason: "opposed" });
  const [opposition] = await db.select().from(prospectionOppositions).where(eq(
    prospectionOppositions.emailHmac,
    prospectionEmailHmac(email),
  ));
  assert.equal(opposition.hmacVersion, 1);
  assert.equal((await db.select().from(prospectionJournal).where(eq(prospectionJournal.dossierId, current.id))).length, journalBefore.length + 1);
});

test("deux transitions concurrentes du même dossier donnent un succès et un conflit", async () => {
  const opened = await openProspectionDossier({
    adminAccountId: accountId, slug: slugs[2], workshopName: "Atelier transition",
    websiteUrl: "https://example.test",
  });
  assert.ok(opened.ok);
  dossierIds.push(opened.value.id);
  const command = {
    adminAccountId: accountId, dossierId: opened.value.id, revision: opened.value.revision,
    state: "inconsistent" as const, reason: "read_refused" as const,
  };
  const results = await Promise.all([
    transitionProspectionDossier(command),
    transitionProspectionDossier(command),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reason === "conflict").length, 1);
});

test("une ouverture sans site naît directement dans l’état no_website", async () => {
  const opened = await openProspectionDossier({
    adminAccountId: accountId, slug: slugs[1], workshopName: "Atelier sans site",
  });
  assert.ok(opened.ok);
  dossierIds.push(opened.value.id);
  const [stored] = await db.select().from(prospectionDossiers)
    .where(eq(prospectionDossiers.id, opened.value.id));
  assert.equal(stored.state, "no_website");
  assert.equal(stored.lastReason, "no_website");
});

test("une opposition concurrente empêche toute ouverture tardive du même contact", async () => {
  const slug = `race-${suffix}`;
  const raceEmail = `race-${suffix}@example.test`;
  additionalSlugs.push(slug);
  await db.insert(novaluthProfilesTable).values({
    slug, name: "Atelier course opposition", entityType: "luthier", status: "candidate",
    data: { slug, nom: "Atelier course opposition", email: raceEmail, site_web: "https://example.test" },
  });
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [`prospection:email:${raceEmail}`]);
    const opening = await openProspectionDossier({ adminAccountId: accountId, slug });
    assert.deepEqual(opening, { ok: false, reason: "locked" });
  } finally {
    await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`prospection:email:${raceEmail}`]);
    client.release();
  }
  const opposed = await recordProspectionOppositionForEmail({
    adminAccountId: accountId, email: raceEmail, origin: "admin_entry",
  });
  assert.ok(opposed.ok);
  const openings = await db.select().from(prospectionDossiers)
    .where(eq(prospectionDossiers.contactEmail, raceEmail));
  assert.ok(openings.every((dossier) => dossier.state === "opposed"));
  const opposition = await db.select().from(prospectionOppositions)
    .where(eq(prospectionOppositions.emailHmac, prospectionEmailHmac(raceEmail)));
  assert.equal(opposition.length, 1);
});

test("une opposition clôt tous les dossiers et retire toutes les propositions du contact", async () => {
  const sharedEmail = `shared-${suffix}@example.test`;
  const sharedSlugs = [`shared-a-${suffix}`, `shared-b-${suffix}`];
  additionalSlugs.push(...sharedSlugs);
  await db.insert(novaluthProfilesTable).values(sharedSlugs.map((slug) => ({
    slug, name: `Atelier ${slug}`, entityType: "luthier", status: "candidate",
    data: { slug, nom: `Atelier ${slug}`, email: sharedEmail, site_web: "https://example.test" },
  })));
  const opened = [
    await openProspectionDossier({ adminAccountId: accountId, slug: sharedSlugs[0] }),
    await openProspectionDossier({ adminAccountId: accountId, slug: sharedSlugs[1] }),
  ];
  const ids = opened.map((result) => {
    assert.ok(result.ok);
    dossierIds.push(result.value.id);
    return result.value.id;
  });
  assert.equal(ids.length, 2);
  const now = new Date();
  for (const id of ids) {
    await db.update(prospectionDossiers).set({
      state: "proposed", hook: "Accroche de test suffisamment longue pour satisfaire les contraintes métier.",
      hookOrigin: "human", verifiedAt: now, hookValidatedAt: now,
      hookValidatedByAccountId: accountId, proposedAt: now,
    }).where(eq(prospectionDossiers.id, id));
    await db.insert(prospectionProposals).values({
      dossierId: id, subject: "Proposition NovaLuth de découverte",
      body: "Bonjour, ".padEnd(220, "x"), recipientHmac: prospectionEmailHmac(sharedEmail),
      recipientHmacVersion: 1, validatedByAccountId: accountId, validatedAt: now, deliveryAllowed: false,
    });
  }
  const outcome = await recordProspectionOppositionForEmail({
    adminAccountId: accountId, email: sharedEmail, origin: "admin_entry",
  });
  assert.deepEqual(outcome, { ok: true, value: { closedDossiers: 2, withdrawnProposals: 2 } });
  const dossiers = await db.select().from(prospectionDossiers).where(inArray(prospectionDossiers.id, ids));
  assert.ok(dossiers.every((dossier) => dossier.state === "opposed"));
  const proposals = await db.select().from(prospectionProposals).where(inArray(prospectionProposals.dossierId, ids));
  assert.ok(proposals.every((proposal) => proposal.withdrawnAt && !proposal.deliveryAllowed));
  const [opposition] = await db.select().from(prospectionOppositions)
    .where(eq(prospectionOppositions.emailHmac, prospectionEmailHmac(sharedEmail)));
  assert.equal("email" in opposition, false);
  const journal = await db.select().from(prospectionJournal).where(inArray(prospectionJournal.dossierId, ids));
  assert.ok(journal.every((entry) => !("email" in entry)));
});

test("une lecture temporairement indisponible ne modifie pas le dossier", async () => {
  const opened = await openProspectionDossier({
    adminAccountId: accountId, slug: slugs[4], workshopName: "Atelier lecture",
    websiteUrl: "https://example.test",
  });
  assert.ok(opened.ok);
  dossierIds.push(opened.value.id);
  const outcome = await verifyProspectionDossier(
    { adminAccountId: accountId, dossierId: opened.value.id, revision: opened.value.revision },
    async () => { throw new Error("gateway timeout"); },
  );
  assert.deepEqual(outcome, { ok: false, reason: "read_unavailable" });
  const [stored] = await db.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, opened.value.id));
  assert.equal(stored.state, "opened");
  assert.equal(stored.revision, opened.value.revision);
});

test("un instantané de page obsolète ne peut pas enregistrer sa cohérence", async () => {
  const [before] = await db.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, dossierIds[5]));
  const outcome = await verifyProspectionDossier(
    { adminAccountId: accountId, dossierId: before.id, revision: before.revision },
    async () => {
      await db.update(prospectionDossiers).set({
        websiteUrl: "https://changed.example.test", revision: before.revision + 1,
      }).where(eq(prospectionDossiers.id, before.id));
      return { url: "https://example.test", url_finale: "https://example.test", titre: "Atelier lecture", texte: "Atelier lecture présente son travail. Atelier lecture fabrique des instruments documentés.", octets: 100, delai_respecte_s: 1 };
    },
  );
  assert.deepEqual(outcome, { ok: false, reason: "conflict" });
});

test("la configuration HMAC de rotation invalide échoue explicitement", () => {
  const previous = process.env.NOVALUTH_PROSPECTION_ACTIVE_HMAC_VERSIONS;
  try {
    process.env.NOVALUTH_PROSPECTION_ACTIVE_HMAC_VERSIONS = "1,,2";
    assert.throws(() => prospectionEmailHmac(email), /ACTIVE_HMAC_VERSIONS est invalide/);
    process.env.NOVALUTH_PROSPECTION_ACTIVE_HMAC_VERSIONS = "2";
    assert.throws(() => prospectionEmailHmac(email), /version HMAC courante doit rester active/);
  } finally {
    if (previous === undefined) delete process.env.NOVALUTH_PROSPECTION_ACTIVE_HMAC_VERSIONS;
    else process.env.NOVALUTH_PROSPECTION_ACTIVE_HMAC_VERSIONS = previous;
  }
});

test("le compte inactif ou non administrateur est refusé dans la transaction", async () => {
  const accounts = await db.insert(novaluthPlatformAccountsTable).values([
    { login: `inactive-${suffix}`, displayName: "Inactive", role: "admin", passwordHash: "x", active: false },
    { login: `artisan-${suffix}`, displayName: "Artisan", role: "artisan", passwordHash: "x", active: true },
  ]).returning({ id: novaluthPlatformAccountsTable.id });
  extraAccountIds.push(...accounts.map(({ id }) => id));
  const [current] = await db.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, dossierIds[0]));
  for (const account of accounts) {
    const result = await transitionProspectionDossier({
      adminAccountId: account.id, dossierId: current.id, revision: current.revision,
      state: "abandoned", reason: "human_decision",
    });
    assert.deepEqual(result, { ok: false, reason: "unauthorized" });
  }
});

test("un échec d'insertion du journal annule la mutation du dossier", async () => {
  await db.execute(sql`
    create or replace function prospection_journal_test_insert_failure()
    returns trigger language plpgsql as $$
    begin raise exception 'journal test failure'; end;
    $$;
    create trigger prospection_journal_test_insert_failure
    before insert on prospection_journal
    for each row execute function prospection_journal_test_insert_failure();
  `);
  try {
    const [before] = await db.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, dossierIds[1]));
    await assert.rejects(transitionProspectionDossier({
      adminAccountId: accountId, dossierId: before.id, revision: before.revision,
      state: "opened", reason: "human_decision",
    }));
    const [after] = await db.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, before.id));
    assert.equal(after.state, before.state);
    assert.equal(after.revision, before.revision);
  } finally {
    await db.execute(sql`drop trigger if exists prospection_journal_test_insert_failure on prospection_journal; drop function if exists prospection_journal_test_insert_failure()`);
  }
});

test("le journal rejette UPDATE et DELETE hors mécanisme de nettoyage explicite", async () => {
  const [entry] = await db.select().from(prospectionJournal)
    .where(eq(prospectionJournal.dossierId, dossierIds[0]));
  await assert.rejects(db.update(prospectionJournal).set({ measure: 1 }).where(eq(prospectionJournal.id, entry.id)));
  await assert.rejects(db.delete(prospectionJournal).where(eq(prospectionJournal.id, entry.id)));
});

test("une correction de destinataire retire atomiquement la proposition active", async () => {
  const opened = await openProspectionDossier({
    adminAccountId: accountId, slug: slugs[3], workshopName: "Atelier correction",
    websiteUrl: "https://example.test", contactEmail: `before-${suffix}@example.test`,
  });
  assert.ok(opened.ok);
  dossierIds.push(opened.value.id);
  const verified = await verifyProspectionDossier(
    { adminAccountId: accountId, dossierId: opened.value.id, revision: opened.value.revision },
    async () => ({ url: "https://example.test", url_finale: "https://example.test", titre: "Atelier correction", texte: "Atelier correction réalise des instruments sur mesure. Atelier correction met en avant son travail artisanal documenté.", octets: 150, delai_respecte_s: 1 }),
  );
  assert.ok(verified.ok);
  const proposed = await validateAndQueueProspectionProposal({
    adminAccountId: accountId, dossierId: opened.value.id, revision: verified.value.revision,
    subject: "Découvrir NovaLuth aujourd'hui", body: "Bonjour, ".padEnd(220, "x"),
  });
  assert.ok(proposed.ok);
  const [current] = await db.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, opened.value.id));
  const stale = await correctProspectionDossier({
    adminAccountId: accountId, dossierId: current.id, revision: current.revision - 1,
    contactEmail: `stale-${suffix}@example.test`,
  });
  assert.deepEqual(stale, { ok: false, reason: "conflict" });
  const [stillActive] = await db.select().from(prospectionProposals).where(eq(prospectionProposals.dossierId, current.id));
  assert.equal(stillActive.withdrawnAt, null);
  const journalBefore = await db.select().from(prospectionJournal).where(eq(prospectionJournal.dossierId, current.id));
  const corrected = await correctProspectionDossier({
    adminAccountId: accountId, dossierId: current.id, revision: current.revision,
    contactEmail: `new-${suffix}@example.test`,
  });
  assert.ok(corrected.ok);
  assert.equal(corrected.value.state, "verified");
  const [dossier] = await db.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, current.id));
  const [proposal] = await db.select().from(prospectionProposals).where(eq(prospectionProposals.dossierId, current.id));
  assert.equal(dossier.hookValidatedAt, null);
  assert.ok(proposal.withdrawnAt);
  assert.equal((await db.select().from(prospectionJournal).where(eq(prospectionJournal.dossierId, current.id))).length, journalBefore.length + 1);
});