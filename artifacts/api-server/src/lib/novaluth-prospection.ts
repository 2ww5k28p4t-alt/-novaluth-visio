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
import { and, eq, isNull, sql } from "drizzle-orm";
import { readPublicPage } from "../gateway/page-harvester";

export type ProspectionFailure =
  | "conflict"
  | "invalid"
  | "not_found"
  | "opposed"
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
  const secret = process.env[`NOVALUTH_PROSPECTION_HMAC_SECRET_V${version}`];
  if (secret) return secret;
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

async function hasOpposition(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  email: string | null,
): Promise<boolean> {
  if (!email) return false;
  const emailHmac = prospectionEmailHmac(email);
  const [opposition] = await tx
    .select({ emailHmac: prospectionOppositions.emailHmac })
    .from(prospectionOppositions)
    .where(
      and(
        eq(prospectionOppositions.emailHmac, emailHmac),
        eq(prospectionOppositions.hmacVersion, PROSPECTION_HMAC_VERSION),
      ),
    );
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
    if (!(await requireAdmin(tx, input.adminAccountId))) {
      return { ok: false, reason: "unauthorized" };
    }
    if (!(await lockWorkshop(tx, input.slug))) {
      return { ok: false, reason: "conflict" };
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

  let page: Awaited<ReturnType<PageReader>>;
  try {
    page = await pageReader(candidate.websiteUrl);
  } catch {
    return transitionProspectionDossier({
      ...input,
      state: "inconsistent",
      reason: "read_refused",
    });
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
    const [dossier] = await tx
      .select()
      .from(prospectionDossiers)
      .where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) {
      return { ok: false, reason: "unauthorized" };
    }
    if (!(await lockWorkshop(tx, dossier.slug))) {
      return { ok: false, reason: "conflict" };
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
    const [dossier] = await tx.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) return { ok: false, reason: "unauthorized" };
    if (!(await lockWorkshop(tx, dossier.slug))) return { ok: false, reason: "conflict" };
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
    const [dossier] = await tx.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) return { ok: false, reason: "unauthorized" };
    if (!(await lockWorkshop(tx, dossier.slug))) return { ok: false, reason: "conflict" };
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
    const [dossier] = await tx.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) return { ok: false, reason: "unauthorized" };
    if (!(await lockWorkshop(tx, dossier.slug))) return { ok: false, reason: "conflict" };
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

export async function recordProspectionOpposition(input: {
  adminAccountId: number;
  dossierId: string;
  revision: number;
  origin: ProspectionOppositionOrigin;
}): Promise<ProspectionResult<{ revision: number; state: ProspectionState }>> {
  return db.transaction(async (tx) => {
    const [dossier] = await tx.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) return { ok: false, reason: "unauthorized" };
    if (!(await lockWorkshop(tx, dossier.slug))) return { ok: false, reason: "conflict" };
    if (!dossier.contactEmail || !isProspectionTransitionAllowed(dossier.state as ProspectionState, "opposed")) {
      return { ok: false, reason: "invalid" };
    }
    const emailHmac = prospectionEmailHmac(dossier.contactEmail);
    await tx.insert(prospectionOppositions).values({
      emailHmac,
      hmacVersion: PROSPECTION_HMAC_VERSION,
      origin: input.origin,
    }).onConflictDoNothing();
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
    const [dossier] = await tx.select().from(prospectionDossiers).where(eq(prospectionDossiers.id, input.dossierId));
    if (!dossier) return { ok: false, reason: "not_found" };
    if (!(await requireAdmin(tx, input.adminAccountId))) return { ok: false, reason: "unauthorized" };
    if (!(await lockWorkshop(tx, dossier.slug))) return { ok: false, reason: "conflict" };
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