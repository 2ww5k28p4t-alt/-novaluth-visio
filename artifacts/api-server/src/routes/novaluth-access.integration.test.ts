import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  novaluthAccessRequestsTable,
  novaluthBriefsTable,
  novaluthEmailOutboxTable,
  novaluthProfilesTable,
  novaluthProjectsTable,
  novaluthSn13DiagnosticsTable,
  pool,
} from "@workspace/db";
import { novaluthSeed } from "../data/novaluth-seed";
import app from "../app";
import {
  enqueueNovaLuthEmail,
  processNovaLuthEmailOutbox,
} from "../lib/novaluth-email-outbox";

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
const deliveredEmails: Array<{
  to?: string[];
  html?: string;
  tags?: Array<{ name: string; value: string }>;
}> = [];
let resendMode: "success" | "temporary" | "permanent" = "success";
const nativeFetch = globalThis.fetch;
const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const sn13ProcessRunner = path.join(
  workspaceRoot,
  "artifacts/api-server/src/routes/sn13-diagnostic-process.integration.ts",
);
const tsxBinary = path.join(workspaceRoot, "scripts/node_modules/.bin/tsx");
const originalEmailConfig = {
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.NOVALUTH_EMAIL_FROM,
  publicUrl: process.env.NOVALUTH_PUBLIC_URL,
};

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
  const body = (await response.json()) as Record<string, unknown>;
  await processNovaLuthEmailOutbox(100);
  return { response, body };
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
  assert.equal(created.body.courriel_envoye, true);
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

type Sn13DiagnosticSnapshot = {
  statut: string;
  requete_id: string | null;
  appele_le: string | null;
  corps_erreur: string | null;
};

type Sn13ProcessOptions = {
  status?: "erreur" | "incomplet" | "vide" | "succes";
  calledAt?: number;
  writeDelayMs?: number;
};

function runSn13Process(
  mode: "write" | "read",
  requestId: string,
  secret: string,
  options: Sn13ProcessOptions = {},
): Promise<Sn13DiagnosticSnapshot> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBinary, [sn13ProcessRunner, mode], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        NODE_ENV: "test",
        SN13_DIAGNOSTIC_TEST_REQUEST_ID: requestId,
        SN13_DIAGNOSTIC_TEST_SECRET: secret,
        SN13_DIAGNOSTIC_TEST_STATUS: options.status ?? "erreur",
        SN13_DIAGNOSTIC_TEST_CALLED_AT: options.calledAt?.toString() ?? "",
        SN13_DIAGNOSTIC_TEST_WRITE_DELAY_MS: options.writeDelayMs?.toString() ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Le processus SN13 ${mode} a échoué (${code}). ${errorOutput.slice(0, 500)}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(output) as Sn13DiagnosticSnapshot);
      } catch {
        reject(new Error(`Réponse JSON invalide du processus SN13 ${mode}.`));
      }
    });
  });
}

before(async () => {
  await db.delete(novaluthEmailOutboxTable);
  process.env.RESEND_API_KEY = "re_test_transactional_email";
  process.env.NOVALUTH_EMAIL_FROM = "NovaLuth <notifications@example.test>";
  process.env.NOVALUTH_PUBLIC_URL = "https://novaluth.example.test";
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.resend.com/emails") {
      if (resendMode === "temporary") {
        return new Response(JSON.stringify({ error: "temporary failure" }), { status: 503 });
      }
      if (resendMode === "permanent") {
        return new Response(JSON.stringify({ error: "invalid recipient" }), { status: 400 });
      }
      deliveredEmails.push(JSON.parse(String(init?.body)) as { tags?: Array<{ name: string; value: string }> });
      return new Response(JSON.stringify({ id: "email_test_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return nativeFetch(input, init);
  };
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  globalThis.fetch = nativeFetch;
  if (originalEmailConfig.apiKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalEmailConfig.apiKey;
  if (originalEmailConfig.from === undefined) delete process.env.NOVALUTH_EMAIL_FROM;
  else process.env.NOVALUTH_EMAIL_FROM = originalEmailConfig.from;
  if (originalEmailConfig.publicUrl === undefined) delete process.env.NOVALUTH_PUBLIC_URL;
  else process.env.NOVALUTH_PUBLIC_URL = originalEmailConfig.publicUrl;
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
  await db.delete(novaluthEmailOutboxTable);
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
  assert.equal(withoutConsent.body.courriel_envoye, false);
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
  const portalEmail = deliveredEmails.find((email) =>
    email.tags?.some(
      (tag) => tag.name === "novaluth_event" && tag.value === "portal_created",
    ),
  );
  assert.deepEqual(portalEmail?.to, [`musicien-${suffix}@example.test`]);
  assert.match(
    portalEmail?.html ?? "",
    new RegExp(
      `https://novaluth\\.example\\.test/projets/${cancellationProject.reference}/portail/${cancellationProject.token}`,
    ),
  );

  await db
    .update(novaluthAccessRequestsTable)
    .set({ requestedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) })
    .where(eq(novaluthAccessRequestsTable.id, pendingId));

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

  await db
    .update(novaluthAccessRequestsTable)
    .set({ accessEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
    .where(eq(novaluthAccessRequestsTable.id, acceptedId));
  await api(`/ateliers/${atelier.slug}/tableau-de-bord`, {
    headers: { "X-NovaLuth-Atelier-Session": atelier.session },
  });

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

  const events = new Set(
    deliveredEmails.flatMap((email) =>
      email.tags
        ?.filter((tag) => tag.name === "novaluth_event")
        .map((tag) => tag.value) ?? [],
    ),
  );
  for (const event of [
    "portal_created",
    "access_request",
    "decision_accepted",
    "decision_refused",
    "request_cancelled",
    "request_expired",
    "pending_reminder",
    "access_expiring_soon",
    "followup",
  ]) {
    assert.ok(events.has(event), `Expected "${event}" email to be sent.`);
  }
});

test("NovaLuth email outbox deduplicates and dead-letters repeated provider failures", async () => {
  const dedupeKey = `outbox-test:${suffix}`;
  const details = {
    event: "portal_created" as const,
    reference: `OUTBOX-${suffix}`,
    portalUrl: "https://novaluth.example.test/projets/test",
  };
  const first = await enqueueNovaLuthEmail(
    db,
    `outbox-${suffix}@example.test`,
    details,
    dedupeKey,
  );
  const duplicate = await enqueueNovaLuthEmail(
    db,
    `outbox-${suffix}@example.test`,
    details,
    dedupeKey,
  );
  assert.equal(first.queued, true);
  assert.equal(first.deduplicated, false);
  assert.equal(duplicate.queued, true);
  assert.equal(duplicate.deduplicated, true);

  resendMode = "temporary";
  await processNovaLuthEmailOutbox();
  let [row] = await db
    .select()
    .from(novaluthEmailOutboxTable)
    .where(eq(novaluthEmailOutboxTable.dedupeKey, dedupeKey));
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 1);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await db
      .update(novaluthEmailOutboxTable)
      .set({ availableAt: new Date(0) })
      .where(eq(novaluthEmailOutboxTable.dedupeKey, dedupeKey));
    await processNovaLuthEmailOutbox();
  }
  [row] = await db
    .select()
    .from(novaluthEmailOutboxTable)
    .where(eq(novaluthEmailOutboxTable.dedupeKey, dedupeKey));
  assert.equal(row.status, "dead");
  assert.equal(row.attempts, 5);
  assert.equal(row.lastStatusCode, 503);

  resendMode = "success";
  await db
    .delete(novaluthEmailOutboxTable)
    .where(eq(novaluthEmailOutboxTable.dedupeKey, dedupeKey));
});

test("SN13 conserve le diagnostic le plus récent lors d’écritures simultanées", async () => {
  const olderRequestId = `sn13-concurrent-older-${randomUUID()}`;
  const newerRequestId = `sn13-concurrent-newer-${randomUUID()}`;
  const olderSecret = `sn13-concurrent-older-secret-${randomUUID()}`;
  const newerSecret = `sn13-concurrent-newer-secret-${randomUUID()}`;
  const olderCalledAt = Date.now();
  const newerCalledAt = olderCalledAt + 1_000;

  await db
    .delete(novaluthSn13DiagnosticsTable)
    .where(eq(novaluthSn13DiagnosticsTable.key, "latest"));
  try {
    await Promise.all([
      runSn13Process("write", olderRequestId, olderSecret, {
        status: "erreur",
        calledAt: olderCalledAt,
        writeDelayMs: 500,
      }),
      runSn13Process("write", newerRequestId, newerSecret, {
        status: "incomplet",
        calledAt: newerCalledAt,
      }),
    ]);
    const read = await runSn13Process("read", newerRequestId, newerSecret);

    assert.equal(read.statut, "incomplet");
    assert.equal(read.requete_id, newerRequestId);
    assert.equal(read.appele_le, new Date(newerCalledAt).toISOString());
    assert.match(
      read.appele_le ?? "",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    assert.match(read.corps_erreur ?? "", /\[REDACTED\]/);
    assert.match(read.corps_erreur ?? "", new RegExp(newerRequestId));
    assert.doesNotMatch(read.corps_erreur ?? "", new RegExp(olderRequestId));
    assert.doesNotMatch(read.corps_erreur ?? "", new RegExp(newerSecret));
    assert.doesNotMatch(read.corps_erreur ?? "", new RegExp(olderSecret));
    assert.doesNotMatch(JSON.stringify(read), new RegExp(newerSecret));
    assert.doesNotMatch(JSON.stringify(read), new RegExp(olderSecret));
  } finally {
    await db
      .delete(novaluthSn13DiagnosticsTable)
      .where(eq(novaluthSn13DiagnosticsTable.key, "latest"));
  }
});
