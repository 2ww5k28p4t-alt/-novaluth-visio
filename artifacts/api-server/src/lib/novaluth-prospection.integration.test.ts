import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
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
  prospectionEmailHmac,
  recordProspectionOpposition,
  validateAndQueueProspectionProposal,
  verifyProspectionDossier,
} from "./novaluth-prospection";

const suffix = randomUUID().slice(0, 10);
const slugs = [`course-${suffix}`, `opposition-${suffix}`];
const email = `Contact.${suffix}@Example.test`;
let accountId = 0;
const dossierIds: string[] = [];

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
    await db.delete(prospectionJournal).where(inArray(prospectionJournal.dossierId, dossierIds));
    await db.delete(prospectionProposals).where(inArray(prospectionProposals.dossierId, dossierIds));
    await db.delete(prospectionDossiers).where(inArray(prospectionDossiers.id, dossierIds));
  }
  await db.delete(prospectionOppositions).where(eq(prospectionOppositions.emailHmac, prospectionEmailHmac(email)));
  if (accountId) {
    await db.delete(novaluthPlatformAccountsTable).where(eq(novaluthPlatformAccountsTable.id, accountId));
  }
  await db.delete(novaluthProfilesTable).where(inArray(novaluthProfilesTable.slug, slugs));
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
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reason === "conflict").length, 1);
  const winner = results.find((result) => result.ok);
  assert.ok(winner?.ok);
  dossierIds.push(winner.value.id);
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
});