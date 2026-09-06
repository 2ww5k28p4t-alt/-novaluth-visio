import { createHmac } from "node:crypto";
import {
  db,
  isProspectionTransitionAllowed,
  novaluthPlatformAccountsTable,
  prospectionDossiers,
  prospectionJournal,
  prospectionOppositions,
  prospectionProposals,
  PROSPECTION_HMAC_VERSION,
  type ProspectionHookOrigin,
  type ProspectionOppositionOrigin,
  type ProspectionState,
} from "@workspace/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { readPublicPage } from "../gateway/page-harvester";
import { PageReadRefused } from "../gateway/page-harvester";

export type ProspectionFailure =
  | "conflict"
  | "invalid"
  | "not_found"
  | "opposed"
  | "read_refused"
  | "read_unavailable"
  | "unauthorized";

export type ProspectionResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ProspectionFailure };

type PageReader = typeof readPublicPage;

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length < 6 ||
    normalized.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new Error("Adresse de prospection invalide.");
  }
  return normalized;
}

function hmacSecret(version: number): string {
  const key = `NOVALUTH_PROSPECTION_HMAC_SECRET_V${version}`;
  const configured = process.env[key];
  if (configured !== undefined) {
    if (!configured.trim()) throw new Error(`Le secret HMAC de prospection v${version} est vide.`);
    return configured;
  }
  const rootSecret = process.env.NOVALUTH_GATEWAY_SECRET;
  if (!rootSecret) throw new Error(`Le secret HMAC de prospection v${version} est absent.`);
  return createHmac("sha256", rootSecret)
    .update(`novaluth-prospection-hmac-v${version}`, "utf8")
    .digest("hex");
}

export function prospectionEmailHmac(
  email: string,
  version = PROSPECTION_HMAC_VERSION,
): string {
  if (!activeHmacVersions().includes(version)) {
    throw new Error(`La version HMAC de prospection v${version} n'est pas active.`);
  }
  return createHmac("sha256", hmacSecret(version))
    .update(normalizeEmail(email), "utf8")
    .digest("hex");
}

async function requireAdmin(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  accountId: number,
): Promise<boolean> {
  const [account] = await tx
    .select({
      role: novaluthPlatformAccountsTable.role,
      active: novaluthPlatformAccountsTable.active,
    })
    .from(novaluthPlatformAccountsTable)
    .where(eq(novaluthPlatformAccountsTable.id, accountId));
  return account?.role === "admin" && account.active;
}

async function lockWorkshop(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  slug: string,
): Promise<boolean> {
  const result = await tx.execute<{ acquired: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${slug}, 0)) as acquired`,
  );
  return result.rows[0]?.acquired === true;
}

/**
 * A dossier id is supplied by the command, so it is the only key that can be
 * locked before looking the dossier up.  Do not derive this key from the slug:
 * doing so would require the business read that the lock is intended to guard.
 */
async function lockDossier(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  dossierId: string,
): Promise<boolean> {
  const result = await tx.execute<{ acquired: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${`prospection:dossier:${dossierId}`}, 0)) as acquired`,
  );
  return result.rows[0]?.acquired === true;
}

function activeHmacVersions(): number[] {
  const configured = process.env.NOVALUTH_PROSPECTION_ACTIVE_HMAC_VERSIONS;
  const raw = configured === undefined ? [String(PROSPECTION_HMAC_VERSION)] : configured.split(",");
  if (!raw.length || raw.some((value) => !/^[1-9][0-9]*$/.test(value.trim()))) {
    throw new Error("NOVALUTH_PROSPECTION_ACTIVE_HMAC_VERSIONS est invalide.");
  }
  const active = [...new Set(raw.map((value) => Number(value.trim())))];
  if (!active.includes(PROSPECTION_HMAC_VERSION)) {
    throw new Error("La version HMAC courante doit rester active.");
  }
  for (const version of active) hmacSecret(version);
  return active;
}

function classifyPageFailure(error: unknown): "read_refused" | "read_unavailable" {
  if (!(error instanceof PageReadRefused)) return "read_unavailable";
  const message = error.message.toLowerCase();
  if (/robots\.txt interdit|réservation|réseau non publique|adresse invalide|seules les adresses|identifiants|ports non standard|réseaux sociaux|données sensibles|contenu non textuel|trop volumineuse/.test(message)) {
    return "read_refused";
  }
  return "read_unavailable";
}

async function hasOpposition(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  email: string | null,
): Promise<boolean> {
  if (!email) return false;
  const fingerprints = activeHmacVersions().map((version) => ({
    version,
    fingerprint: prospectionEmailHmac(email, version),
  }));
  // The primary key (email_hmac, hmac_version) makes this bounded lookup an
  // indexed probe for every active rotation version.
  const [opposition] = await tx
    .select({ emailHmac: prospectionOppositions.emailHmac })
    .from(prospectionOppositions)
    .where(or(...fingerprints.map(({ version, fingerprint }) =>
      and(
        eq(prospectionOppositions.emailHmac, fingerprint),
        eq(prospectionOppositions.hmacVersion, version),
      ),
    )));
  return Boolean(opposition);
}

export async function openProspectionDossier(input: {
  adminAccountId: number;
  slug: string;
  workshopName: string;
  websiteUrl?: string | null;
  contactEmail?: string | null;
  contactFirstName?: string | null;
}): Promise<ProspectionResult<{ id: string; revision: number }>> {
  return db.transaction(async (tx) => {
    if (!(await lockWorkshop(tx, input.slug))) {
      return { ok: false, reason: "conflict" };
    }
    if (!(await requireAdmin(tx, input.adminAccountId))) {
      return { ok: false, reason: "unauthorized" };
    }
    const email = input.contactEmail
      ? normalizeEmail(input.contactEmail)
      : null;
    if (await hasOpposition(tx, email)) {
      return { ok: false, reason: "opposed" };
    }
    const [existing] = await tx
      .select({ id: prospectionDossiers.id })
      .from(prospectionDossiers)
      .where(eq(prospectionDossiers.slug, input.slug));
    if (existing) return { ok: false, reason: "conflict" };
    const [dossier] = await tx
      .insert(prospectionDossiers)
      .values({
        slug: input.slug,
        workshopName: input.workshopName.trim(),
        websiteUrl: input.websiteUrl?.trim() || null,
        contactEmail: email,
        contactFirstName: input.contactFirstName?.trim() || null,
      })
      .returning({ id: prospectionDossiers.id, revision: prospectionDossiers.revision });
    await tx.insert(prospectionJournal).values({
      dossierId: dossier.id,
      slug: input.slug,
      event: "dossier_opened",
      stateAfter: "opened",
    });
    return { ok: true, value: dossier };
  });
}

function shortSignal(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 200);
}

export async function verifyProspectionDossier(
  input: {
    adminAccountId: number;
    dossierId: string;
    revision: number;
  },
  pageReader: PageReader = readPublicPage,
): Promise<ProspectionResult<{ revision: number; state: ProspectionState }>> {
  const [candidate] = await db
    .select({
      websiteUrl: prospectionDossiers.websiteUrl,
      workshopName: prospectionDossiers.workshopName,
    })
    .from(prospectionDossiers)
    .where(eq(prospectionDossiers.id, input.dossierId));
  if (!candidate) return { ok: false, reason: "not_found" };

  if (!candidate.websiteUrl) {
    return transitionProspectionDossier({
      ...input,
      state: "no_website",
      reason: "no_website",
    });
  }
  const websiteUrl = candidate.websiteUrl;

  let page: Awaited<ReturnType<PageReader>>;
  try {
    page = await pageReader(websiteUrl);
  } catch (error) {
    const reason = classifyPageFailure(error);
    if (reason === "read_unavailable") return { ok: false, reason };
    return transitionProspectionDossier({ ...input, state: "inconsistent", reason: "read_refused" });
  }
  const haystack = `${page.titre}\n${page.texte}`.toLocaleLowerCase("fr");
  const words = candidate.workshopName
    .toLocaleLowerCase("fr")
    .split(/\s+/)
    .filter((word) => word.length >= 4);
  const signals = words
    .filter((word) => haystack.includes(word))
    .slice(0, 20)
    .map((word) => shortSignal(`Le nom public contient « ${word} ».`));
  const accepted = signals.length >= 2 && page.texte.trim().length >= 80;

  return db.transaction(async (tx) => {
    if (!(await lockDossier(tx, input.dossierId))) {
      return { ok: false, reason: "conflict" };
    }
    const [dossier] = await tx
      .select()
      .from(prospectionDossiers)
      .where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) {
      return { ok: false, reason: "unauthorized" };
    }
    if (await hasOpposition(tx, dossier.contactEmail)) {
      return { ok: false, reason: "opposed" };
    }
    if (dossier.state !== "opened") return { ok: false, reason: "invalid" };
    const now = new Date();
    const state: ProspectionState = accepted ? "verified" : "inconsistent";
    const [saved] = await tx
      .update(prospectionDossiers)
      .set({
        state,
        hook: accepted
          ? shortSignal(
              `Votre présence publique met en avant ${signals
                .map((signal) => signal.match(/« (.+) »/)?.[1])
                .filter(Boolean)
                .join(" et ")}, des éléments qui font écho à la sélection NovaLuth.`,
            )
          : null,
        hookOrigin: accepted ? "signals" : null,
        verifiedSignals: signals,
        verifiedAt: accepted ? now : null,
        revision: dossier.revision + 1,
        lastReason: accepted ? null : signals.length < 2 ? "insufficient_signals" : "page_too_short",
      })
      .where(
        and(
          eq(prospectionDossiers.id, dossier.id),
          eq(prospectionDossiers.state, "opened"),
          eq(prospectionDossiers.revision, input.revision),
          eq(prospectionDossiers.websiteUrl, websiteUrl),
          eq(prospectionDossiers.workshopName, candidate.workshopName),
        ),
      )
      .returning({ revision: prospectionDossiers.revision });
    if (!saved) return { ok: false, reason: "conflict" };
    await tx.insert(prospectionJournal).values({
      dossierId: dossier.id,
      slug: dossier.slug,
      event: accepted ? "coherence_accepted" : "coherence_refused",
      stateBefore: "opened",
      stateAfter: state,
      reason: accepted ? null : signals.length < 2 ? "insufficient_signals" : "page_too_short",
      measure: signals.length,
    });
    return { ok: true, value: { revision: saved.revision, state } };
  });
}

export async function validateProspectionHook(input: {
  adminAccountId: number;
  dossierId: string;
  revision: number;
  hook: string;
  hookOrigin: ProspectionHookOrigin;
}): Promise<ProspectionResult<{ revision: number; state: ProspectionState }>> {
  return db.transaction(async (tx) => {
    if (!(await lockDossier(tx, input.dossierId))) return { ok: false, reason: "conflict" };
    const [dossier] = await tx.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) return { ok: false, reason: "unauthorized" };
    if (await hasOpposition(tx, dossier.contactEmail)) return { ok: false, reason: "opposed" };
    if (dossier.state !== "verified") return { ok: false, reason: "invalid" };
    const now = new Date();
    const [saved] = await tx.update(prospectionDossiers).set({
      state: "draft_ready",
      hook: input.hook.trim(),
      hookOrigin: input.hookOrigin,
      hookValidatedAt: now,
      hookValidatedByAccountId: input.adminAccountId,
      revision: dossier.revision + 1,
      lastReason: "human_validation",
    }).where(and(
      eq(prospectionDossiers.id, dossier.id),
      eq(prospectionDossiers.state, "verified"),
      eq(prospectionDossiers.revision, input.revision),
    )).returning({ revision: prospectionDossiers.revision });
    if (!saved) return { ok: false, reason: "conflict" };
    await tx.insert(prospectionJournal).values({
      dossierId: dossier.id,
      slug: dossier.slug,
      event: "hook_validated",
      stateBefore: "verified",
      stateAfter: "draft_ready",
      reason: "human_validation",
    });
    return { ok: true, value: { revision: saved.revision, state: "draft_ready" } };
  });
}

export async function queueProspectionProposal(input: {
  adminAccountId: number;
  dossierId: string;
  revision: number;
  subject: string;
  body: string;
}): Promise<ProspectionResult<{ revision: number; state: ProspectionState }>> {
  return db.transaction(async (tx) => {
    if (!(await lockDossier(tx, input.dossierId))) return { ok: false, reason: "conflict" };
    const [dossier] = await tx.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) return { ok: false, reason: "unauthorized" };
    if (await hasOpposition(tx, dossier.contactEmail)) return { ok: false, reason: "opposed" };
    if (dossier.state !== "draft_ready" || !dossier.contactEmail || !dossier.hookValidatedAt) {
      return { ok: false, reason: "invalid" };
    }
    const [active] = await tx.select({ id: prospectionProposals.id }).from(prospectionProposals).where(and(
      eq(prospectionProposals.dossierId, dossier.id),
      isNull(prospectionProposals.withdrawnAt),
    ));
    if (active) return { ok: false, reason: "conflict" };
    const now = new Date();
    const [saved] = await tx.update(prospectionDossiers).set({
      state: "proposed",
      proposedAt: now,
      revision: dossier.revision + 1,
      lastReason: "human_validation",
    }).where(and(
      eq(prospectionDossiers.id, dossier.id),
      eq(prospectionDossiers.state, "draft_ready"),
      eq(prospectionDossiers.revision, input.revision),
    )).returning({ revision: prospectionDossiers.revision });
    if (!saved) return { ok: false, reason: "conflict" };
    await tx.insert(prospectionProposals).values({
      dossierId: dossier.id,
      subject: input.subject.trim(),
      body: input.body.trim(),
      recipientHmac: prospectionEmailHmac(dossier.contactEmail),
      recipientHmacVersion: PROSPECTION_HMAC_VERSION,
      validatedByAccountId: input.adminAccountId,
      validatedAt: now,
      deliveryAllowed: false,
    });
    await tx.insert(prospectionJournal).values({
      dossierId: dossier.id,
      slug: dossier.slug,
      event: "queued",
      stateBefore: "draft_ready",
      stateAfter: "proposed",
      reason: "human_validation",
    });
    return { ok: true, value: { revision: saved.revision, state: "proposed" } };
  });
}

export async function validateAndQueueProspectionProposal(input: {
  adminAccountId: number;
  dossierId: string;
  revision: number;
  subject: string;
  body: string;
}): Promise<ProspectionResult<{ revision: number; state: ProspectionState }>> {
  return db.transaction(async (tx) => {
    if (!(await lockDossier(tx, input.dossierId))) return { ok: false, reason: "conflict" };
    const [dossier] = await tx.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) return { ok: false, reason: "unauthorized" };
    if (await hasOpposition(tx, dossier.contactEmail)) return { ok: false, reason: "opposed" };
    if (!["verified", "draft_ready"].includes(dossier.state) || !dossier.contactEmail || !dossier.hook || !dossier.hookOrigin) {
      return { ok: false, reason: "invalid" };
    }
    const [active] = await tx.select({ id: prospectionProposals.id }).from(prospectionProposals).where(and(
      eq(prospectionProposals.dossierId, dossier.id),
      isNull(prospectionProposals.withdrawnAt),
    ));
    if (active) return { ok: false, reason: "conflict" };
    const now = new Date();
    const [saved] = await tx.update(prospectionDossiers).set({
      state: "proposed",
      hookValidatedAt: dossier.hookValidatedAt ?? now,
      hookValidatedByAccountId: dossier.hookValidatedByAccountId ?? input.adminAccountId,
      proposedAt: now,
      revision: dossier.revision + 1,
      lastReason: "human_validation",
    }).where(and(
      eq(prospectionDossiers.id, dossier.id),
      eq(prospectionDossiers.state, dossier.state),
      eq(prospectionDossiers.revision, input.revision),
    )).returning({ revision: prospectionDossiers.revision });
    if (!saved) return { ok: false, reason: "conflict" };
    await tx.insert(prospectionProposals).values({
      dossierId: dossier.id,
      subject: input.subject.trim(),
      body: input.body.trim(),
      recipientHmac: prospectionEmailHmac(dossier.contactEmail),
      recipientHmacVersion: PROSPECTION_HMAC_VERSION,
      validatedByAccountId: input.adminAccountId,
      validatedAt: now,
      deliveryAllowed: false,
    });
    if (dossier.state === "verified") {
      await tx.insert(prospectionJournal).values({
        dossierId: dossier.id,
        slug: dossier.slug,
        event: "hook_validated",
        stateBefore: "verified",
        stateAfter: "draft_ready",
        reason: "human_validation",
      });
    }
    await tx.insert(prospectionJournal).values({
      dossierId: dossier.id,
      slug: dossier.slug,
      event: "queued",
      stateBefore: dossier.state === "verified" ? "draft_ready" : dossier.state,
      stateAfter: "proposed",
      reason: "human_validation",
    });
    return { ok: true, value: { revision: saved.revision, state: "proposed" } };
  });
}

export async function correctProspectionDossier(input: {
  adminAccountId: number;
  dossierId: string;
  revision: number;
  contactEmail?: string | null;
  contactFirstName?: string | null;
  hook?: string | null;
  hookOrigin?: ProspectionHookOrigin | null;
  subject?: string;
  body?: string;
}): Promise<ProspectionResult<{ revision: number; state: ProspectionState }>> {
  return db.transaction(async (tx) => {
    if (!(await lockDossier(tx, input.dossierId))) return { ok: false, reason: "conflict" };
    const [dossier] = await tx.select().from(prospectionDossiers)
      .where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) return { ok: false, reason: "unauthorized" };

    const contactEmail = input.contactEmail === undefined
      ? dossier.contactEmail
      : input.contactEmail ? normalizeEmail(input.contactEmail) : null;
    if (await hasOpposition(tx, contactEmail)) return { ok: false, reason: "opposed" };
    const hook = input.hook === undefined ? dossier.hook : input.hook?.trim() || null;
    const hookOrigin = input.hookOrigin === undefined ? dossier.hookOrigin : input.hookOrigin;
    const recipientOrHookChanged = contactEmail !== dossier.contactEmail ||
      hook !== dossier.hook || hookOrigin !== dossier.hookOrigin;
    const [proposal] = await tx.select().from(prospectionProposals).where(and(
      eq(prospectionProposals.dossierId, dossier.id),
      isNull(prospectionProposals.withdrawnAt),
    ));
    if (proposal && !activeHmacVersions().includes(proposal.recipientHmacVersion)) {
      return { ok: false, reason: "invalid" };
    }
    if (proposal && recipientOrHookChanged) {
      // A frozen recipient/hook can never be silently edited.  The dossier is
      // returned to verification and its human validation is deliberately
      // cleared, requiring an explicit new review before it can be proposed.
      if (!hook || !hookOrigin) return { ok: false, reason: "invalid" };
    }
    const nextState: ProspectionState = proposal && recipientOrHookChanged ? "verified" : dossier.state as ProspectionState;
    const [saved] = await tx.update(prospectionDossiers).set({
      contactEmail,
      contactFirstName: input.contactFirstName === undefined ? dossier.contactFirstName : input.contactFirstName?.trim() || null,
      hook,
      hookOrigin,
      state: nextState,
      hookValidatedAt: proposal && recipientOrHookChanged ? null : dossier.hookValidatedAt,
      hookValidatedByAccountId: proposal && recipientOrHookChanged ? null : dossier.hookValidatedByAccountId,
      proposedAt: proposal && recipientOrHookChanged ? null : dossier.proposedAt,
      revision: dossier.revision + 1,
      lastReason: proposal && recipientOrHookChanged ? "removed_from_queue" : "record_corrected",
    }).where(and(
      eq(prospectionDossiers.id, dossier.id),
      eq(prospectionDossiers.state, dossier.state),
      eq(prospectionDossiers.revision, input.revision),
    ))
      .returning({ revision: prospectionDossiers.revision });
    if (!saved) return { ok: false, reason: "conflict" };
    if (proposal && recipientOrHookChanged) {
      await tx.update(prospectionProposals).set({ withdrawnAt: new Date(), deliveryAllowed: false })
        .where(and(eq(prospectionProposals.id, proposal.id), isNull(prospectionProposals.withdrawnAt)));
    } else if (proposal && (input.subject !== undefined || input.body !== undefined)) {
      await tx.update(prospectionProposals).set({
        subject: input.subject?.trim() ?? proposal.subject,
        body: input.body?.trim() ?? proposal.body,
        deliveryAllowed: false,
      }).where(and(eq(prospectionProposals.id, proposal.id), isNull(prospectionProposals.withdrawnAt)));
    }
    await tx.insert(prospectionJournal).values({
      dossierId: dossier.id, slug: dossier.slug,
      event: proposal && recipientOrHookChanged ? "dequeued" : "state_changed",
      stateBefore: dossier.state, stateAfter: nextState,
      reason: proposal && recipientOrHookChanged ? "removed_from_queue" : "record_corrected",
    });
    return { ok: true, value: { revision: saved.revision, state: nextState } };
  });
}

export async function withdrawProspectionProposal(input: {
  adminAccountId: number; dossierId: string; revision: number;
}): Promise<ProspectionResult<{ revision: number; state: ProspectionState }>> {
  return db.transaction(async (tx) => {
    if (!(await lockDossier(tx, input.dossierId))) return { ok: false, reason: "conflict" };
    const [dossier] = await tx.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) return { ok: false, reason: "unauthorized" };
    const [proposal] = await tx.select().from(prospectionProposals).where(and(eq(prospectionProposals.dossierId, dossier.id), isNull(prospectionProposals.withdrawnAt)));
    if (!proposal || dossier.state !== "proposed") return { ok: false, reason: "not_found" };
    const [saved] = await tx.update(prospectionDossiers).set({
      state: "draft_ready", revision: dossier.revision + 1, lastReason: "removed_from_queue", proposedAt: null,
    }).where(and(eq(prospectionDossiers.id, dossier.id), eq(prospectionDossiers.state, "proposed"), eq(prospectionDossiers.revision, input.revision)))
      .returning({ revision: prospectionDossiers.revision });
    if (!saved) return { ok: false, reason: "conflict" };
    await tx.update(prospectionProposals).set({ withdrawnAt: new Date(), deliveryAllowed: false }).where(eq(prospectionProposals.id, proposal.id));
    await tx.insert(prospectionJournal).values({ dossierId: dossier.id, slug: dossier.slug, event: "dequeued", stateBefore: "proposed", stateAfter: "draft_ready", reason: "removed_from_queue" });
    return { ok: true, value: { revision: saved.revision, state: "draft_ready" } };
  });
}

export async function recordProspectionOpposition(input: {
  adminAccountId: number;
  dossierId: string;
  revision: number;
  origin: ProspectionOppositionOrigin;
}): Promise<ProspectionResult<{ revision: number; state: ProspectionState }>> {
  return db.transaction(async (tx) => {
    if (!(await lockDossier(tx, input.dossierId))) return { ok: false, reason: "conflict" };
    const [dossier] = await tx.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) return { ok: false, reason: "unauthorized" };
    if (!dossier.contactEmail || !isProspectionTransitionAllowed(dossier.state as ProspectionState, "opposed")) {
      return { ok: false, reason: "invalid" };
    }
    const now = new Date();
    const [saved] = await tx.update(prospectionDossiers).set({
      state: "opposed",
      revision: dossier.revision + 1,
      lastReason: "opposition_active",
      closedAt: now,
    }).where(and(
      eq(prospectionDossiers.id, dossier.id),
      eq(prospectionDossiers.state, dossier.state),
      eq(prospectionDossiers.revision, input.revision),
    )).returning({ revision: prospectionDossiers.revision });
    if (!saved) return { ok: false, reason: "conflict" };
    await tx.insert(prospectionOppositions).values(
      activeHmacVersions().map((hmacVersion) => ({
        emailHmac: prospectionEmailHmac(dossier.contactEmail!, hmacVersion),
        hmacVersion,
        origin: input.origin,
      })),
    ).onConflictDoNothing();
    await tx.update(prospectionProposals).set({ withdrawnAt: now, deliveryAllowed: false })
      .where(and(
        eq(prospectionProposals.dossierId, dossier.id),
        isNull(prospectionProposals.withdrawnAt),
      ));
    await tx.insert(prospectionJournal).values({
      dossierId: dossier.id,
      slug: dossier.slug,
      event: "opposition_recorded",
      stateBefore: dossier.state,
      stateAfter: "opposed",
      reason: "opposition_active",
    });
    return { ok: true, value: { revision: saved.revision, state: "opposed" } };
  });
}

export async function transitionProspectionDossier(input: {
  adminAccountId: number;
  dossierId: string;
  revision: number;
  state: ProspectionState;
  reason: "human_decision" | "no_website" | "read_refused";
}): Promise<ProspectionResult<{ revision: number; state: ProspectionState }>> {
  return db.transaction(async (tx) => {
    if (!(await lockDossier(tx, input.dossierId))) return { ok: false, reason: "conflict" };
    const [dossier] = await tx.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) return { ok: false, reason: "unauthorized" };
    if (await hasOpposition(tx, dossier.contactEmail)) return { ok: false, reason: "opposed" };
    if (input.state === "opposed" || !isProspectionTransitionAllowed(dossier.state as ProspectionState, input.state)) {
      return { ok: false, reason: "invalid" };
    }
    const now = new Date();
    const dates =
      input.state === "sent"
        ? { sentAt: now }
        : input.state === "followed_up"
          ? { followedUpAt: now, followUpCount: 1 }
          : input.state === "replied"
            ? { repliedAt: now }
            : ["enrolled", "declined", "no_reply", "abandoned"].includes(input.state)
              ? { closedAt: now }
              : {};
    const [saved] = await tx.update(prospectionDossiers).set({
      state: input.state,
      revision: dossier.revision + 1,
      lastReason: input.reason,
      ...dates,
    }).where(and(
      eq(prospectionDossiers.id, dossier.id),
      eq(prospectionDossiers.state, dossier.state),
      eq(prospectionDossiers.revision, input.revision),
    )).returning({ revision: prospectionDossiers.revision });
    if (!saved) return { ok: false, reason: "conflict" };
    await tx.insert(prospectionJournal).values({
      dossierId: dossier.id,
      slug: dossier.slug,
      event: "state_changed",
      stateBefore: dossier.state,
      stateAfter: input.state,
      reason: input.reason,
    });
    return { ok: true, value: { revision: saved.revision, state: input.state } };
  });
}