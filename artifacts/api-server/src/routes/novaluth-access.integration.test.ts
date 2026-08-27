import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  novaluthAccessRequestsTable,
  novaluthBriefsTable,
  novaluthProfilesTable,
  novaluthProjectsTable,
  pool,
} from "@workspace/db";
import { novaluthSeed } from "../data/novaluth-seed";
import app from "../app";

type JsonResponse = {
  response: Response;
  body: Record<string, unknown>;
};

type Project = {
  reference: string;
  token: string;
  description: string;
};

let server: Server;
let origin = "";
const references: string[] = [];
const atelierSlugs: string[] = [];

const suffix = randomUUID().slice(0, 8);

function brief(
  consent: boolean,
  description = `Projet de test ${suffix}`,
): {
  type_instrument: "electrique";
  budget_min_eur: number;
  budget_max_eur: number;
  styles: string[];
  bois_souhaites: string[];
  delai_max_mois: number;
  zone_preferee: "france";
  personnalisation: boolean;
  description_libre: string;
  email: string | null;
  consentement_transmission: boolean;
} {
  return {
    type_instrument: "electrique",
    budget_min_eur: 1200,
    budget_max_eur: 3000,
    styles: ["rock"],
    bois_souhaites: ["érable"],
    delai_max_mois: 12,
    zone_preferee: "france",
    personnalisation: true,
    description_libre: description,
    email: `musicien-${suffix}@example.test`,
    consentement_transmission: consent,
  };
}

async function api(path: string, init: RequestInit = {}): Promise<JsonResponse> {
  const response = await fetch(`${origin}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

async function createAtelier() {
  const source = structuredClone(
    novaluthSeed.find((fiche) => fiche.statut === "publiee") ?? novaluthSeed[0],
  );
  const slug = `test-acces-${randomUUID().slice(0, 12)}`;
  const data = {
    ...source,
    slug,
    nom: `Atelier de test ${suffix}`,
    statut: "publiee" as const,
    demonstration: true,
  };
  atelierSlugs.push(slug);
  await db.insert(novaluthProfilesTable).values({
    slug,
    name: data.nom,
    entityType: data.type,
    country: data.pays,
    city: data.ville,
    status: "publiee",
    innovationScore: data.innovation.niveau ?? data.score_innovation,
    minimumPriceEur: data.prix_min_eur,
    maximumPriceEur: data.prix_max_eur,
    data,
    isDemo: true,
  });
  const opened = await api(`/ateliers/${slug}/session`, {
    method: "POST",
    body: JSON.stringify({ code_demo: "NOVALUTH-DEMO" }),
  });
  assert.equal(opened.response.status, 200);
  return { slug, session: String(opened.body.session) };
}

async function createProject(description: string): Promise<Project> {
  const created = await api("/briefs", {
    method: "POST",
    body: JSON.stringify(brief(true, description)),
  });
  assert.equal(created.response.status, 201);
  const portal = String(created.body.portail_musicien);
  assert.notEqual(portal, "null");
  const [, , reference, , token] = new URL(portal, origin).pathname.split("/");
  references.push(reference);
  return { reference, token, description };
}

async function makeProjectAvailable(project: Project, atelierSlug: string) {
  await db
    .update(novaluthProjectsTable)
    .set({ recommendedAteliers: [atelierSlug] })
    .where(eq(novaluthProjectsTable.reference, project.reference));
}

async function requestAccess(
  atelier: { slug: string; session: string },
  project: Project,
  offer: "essentiel" | "atelier" | "signature" = "essentiel",
) {
  return api(`/ateliers/${atelier.slug}/demandes`, {
    method: "POST",
    body: JSON.stringify({
      session: atelier.session,
      reference_projet: project.reference,
      offre: offer,
    }),
  });
}

before(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (references.length) {
    await db
      .delete(novaluthAccessRequestsTable)
      .where(inArray(novaluthAccessRequestsTable.projectReference, references));
    await db.delete(novaluthProjectsTable).where(inArray(novaluthProjectsTable.reference, references));
    await db.delete(novaluthBriefsTable).where(inArray(novaluthBriefsTable.reference, references));
  }
  if (atelierSlugs.length) {
    await db.delete(novaluthProfilesTable).where(inArray(novaluthProfilesTable.slug, atelierSlugs));
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
});

test("NovaLuth blocks early sharing and early capture across the access lifecycle", async () => {
  const withoutConsent = await api("/briefs", {
    method: "POST",
    body: JSON.stringify(brief(false, `Sans consentement ${suffix}`)),
  });
  assert.equal(withoutConsent.response.status, 201);
  assert.equal(withoutConsent.body.portail_musicien, null);
  const noConsentReference = String(withoutConsent.body.reference);
  references.push(noConsentReference);
  const [storedBrief] = await db
    .select()
    .from(novaluthBriefsTable)
    .where(eq(novaluthBriefsTable.reference, noConsentReference));
  const [unsharedProject] = await db
    .select()
    .from(novaluthProjectsTable)
    .where(eq(novaluthProjectsTable.reference, noConsentReference));
  assert.equal(storedBrief.email, null);
  assert.equal(storedBrief.consent, false);
  assert.equal(unsharedProject, undefined);

  const missingEmail = brief(true, `Consentement sans e-mail ${suffix}`);
  missingEmail.email = null;
  const rejectedConsent = await api("/briefs", {
    method: "POST",
    body: JSON.stringify(missingEmail),
  });
  assert.equal(rejectedConsent.response.status, 400);

  const atelier = await createAtelier();
  const cancellationProject = await createProject(`Annulation ${suffix}`);
  await makeProjectAvailable(cancellationProject, atelier.slug);
  const pending = await requestAccess(atelier, cancellationProject);
  assert.equal(pending.response.status, 201);
  assert.equal(pending.body.statut, "en_attente");
  assert.equal(pending.body.statut_paiement, "preautorise");
  const pendingId = Number(pending.body.id);

  const pendingDashboard = await api(`/ateliers/${atelier.slug}/tableau-de-bord`, {
    headers: { "X-NovaLuth-Atelier-Session": atelier.session },
  });
  assert.equal(pendingDashboard.response.status, 200);
  const pendingRequest = (pendingDashboard.body.demandes as Record<string, unknown>[]).find(
    (request) => request.id === pendingId,
  );
  assert.equal((pendingRequest?.projet as Record<string, unknown>).description, null);

  const cancelled = await api(`/ateliers/${atelier.slug}/demandes/${pendingId}/annulation`, {
    method: "POST",
    body: JSON.stringify({ session: atelier.session }),
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.statut, "annulee");
  assert.equal(cancelled.body.statut_paiement, "annule");

  const refusalProject = await createProject(`Refus ${suffix}`);
  await makeProjectAvailable(refusalProject, atelier.slug);
  const refusedPending = await requestAccess(atelier, refusalProject);
  const refused = await api(
    `/projets/${refusalProject.reference}/portail/${refusalProject.token}/demandes/${refusedPending.body.id}/decision`,
    { method: "POST", body: JSON.stringify({ decision: "refuser" }) },
  );
  assert.equal(refused.response.status, 200);
  assert.equal(refused.body.statut, "refusee");
  assert.equal(refused.body.statut_paiement, "annule");
  assert.equal(refused.body.expire_le, null);

  const acceptedProject = await createProject(`Acceptation ${suffix}`);
  await makeProjectAvailable(acceptedProject, atelier.slug);
  const acceptedPending = await requestAccess(atelier, acceptedProject, "signature");
  const acceptedId = Number(acceptedPending.body.id);
  const accepted = await api(
    `/projets/${acceptedProject.reference}/portail/${acceptedProject.token}/demandes/${acceptedId}/decision`,
    { method: "POST", body: JSON.stringify({ decision: "accepter" }) },
  );
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.statut, "acceptee");
  assert.equal(accepted.body.statut_paiement, "encaisse");
  assert.ok(accepted.body.expire_le);

  const acceptedDashboard = await api(`/ateliers/${atelier.slug}/tableau-de-bord`, {
    headers: { "X-NovaLuth-Atelier-Session": atelier.session },
  });
  const acceptedPass = (acceptedDashboard.body.carnets as Record<string, unknown>[]).find(
    (request) => request.id === acceptedId,
  );
  assert.equal((acceptedPass?.projet as Record<string, unknown>).description, acceptedProject.description);

  const followups = await Promise.all(
    Array.from({ length: 4 }, () =>
      api(`/ateliers/${atelier.slug}/carnets/${acceptedId}/relance`, {
        method: "POST",
        body: JSON.stringify({ session: atelier.session }),
      }),
    ),
  );
  const successfulFollowups = followups.filter((followup) => followup.response.status === 200);
  assert.equal(successfulFollowups.length, 3);
  assert.deepEqual(
    successfulFollowups
      .map((followup) => Number(followup.body.credits_relance))
      .sort((left, right) => left - right),
    [0, 1, 2],
  );
  assert.equal(followups.filter((followup) => followup.response.status === 400).length, 1);

  const expiringProject = await createProject(`Expiration ${suffix}`);
  await makeProjectAvailable(expiringProject, atelier.slug);
  const expiringPending = await requestAccess(atelier, expiringProject, "atelier");
  const expiringId = Number(expiringPending.body.id);
  await api(
    `/projets/${expiringProject.reference}/portail/${expiringProject.token}/demandes/${expiringId}/decision`,
    { method: "POST", body: JSON.stringify({ decision: "accepter" }) },
  );
  await db
    .update(novaluthAccessRequestsTable)
    .set({ accessEndsAt: new Date(Date.now() - 1_000) })
    .where(eq(novaluthAccessRequestsTable.id, expiringId));
  const expiredFollowup = await api(`/ateliers/${atelier.slug}/carnets/${expiringId}/relance`, {
    method: "POST",
    body: JSON.stringify({ session: atelier.session }),
  });
  assert.equal(expiredFollowup.response.status, 400);
  const [expired] = await db
    .select()
    .from(novaluthAccessRequestsTable)
    .where(eq(novaluthAccessRequestsTable.id, expiringId));
  assert.equal(expired.status, "expiree");
  assert.equal(expired.paymentStatus, "encaisse");

  const limitAtelier = await createAtelier();
  const limitProjects = await Promise.all(
    Array.from({ length: 4 }, async (_, index) => {
      const project = await createProject(`Limite ${index} ${suffix}`);
      await makeProjectAvailable(project, limitAtelier.slug);
      return project;
    }),
  );
  const limitedRequests = await Promise.all(
    limitProjects.map((project) => requestAccess(limitAtelier, project)),
  );
  assert.equal(limitedRequests.filter((request) => request.response.status === 201).length, 3);
  assert.equal(limitedRequests.filter((request) => request.response.status === 400).length, 1);
  const firstCreatedIndex = limitedRequests.findIndex((request) => request.response.status === 201);
  const firstCreated = limitedRequests[firstCreatedIndex];
  const blockedProject = limitProjects[limitedRequests.findIndex((request) => request.response.status === 400)];
  assert.ok(firstCreated);
  const acceptedLimit = await api(
    `/projets/${limitProjects[firstCreatedIndex].reference}/portail/${limitProjects[firstCreatedIndex].token}/demandes/${firstCreated.body.id}/decision`,
    { method: "POST", body: JSON.stringify({ decision: "accepter" }) },
  );
  assert.equal(acceptedLimit.response.status, 200);
  const stillFull = await requestAccess(limitAtelier, blockedProject);
  assert.equal(stillFull.response.status, 400);
  const cancellable = limitedRequests.find(
    (request, index) => request.response.status === 201 && index !== firstCreatedIndex,
  );
  assert.ok(cancellable);
  const released = await api(
    `/ateliers/${limitAtelier.slug}/demandes/${cancellable.body.id}/annulation`,
    { method: "POST", body: JSON.stringify({ session: limitAtelier.session }) },
  );
  assert.equal(released.response.status, 200);
  const replacement = await requestAccess(limitAtelier, blockedProject);
  assert.equal(replacement.response.status, 201);
});