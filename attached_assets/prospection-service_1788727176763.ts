/**
 * Novaluth — Prospection · LOT 1B : service transactionnel
 * ========================================================
 *
 * Emplacement : artifacts/api-server/src/lib/prospection/prospection-service.ts
 *
 * Ce module est le SEUL détenteur du droit d'écriture sur les tables
 * prospection_*. C'est ce qui donne sa valeur à la machine à états déclarée dans
 * le schéma : PostgreSQL ne connaît pas les transitions, seul ce service les
 * fait respecter.
 *
 * Cinq garanties tenues ici
 * -------------------------
 *  1. Transition, opposition et journal appartiennent à la MÊME transaction.
 *     Aucun état ne change sans laisser sa trace, et inversement.
 *  2. Verrou consultatif transactionnel par dossier, puis mise à jour
 *     conditionnée par (id, state, revision). Deux opérateurs simultanés
 *     donnent un succès et une erreur explicite, jamais deux succès — c'est la
 *     réponse à la tâche #89.
 *  3. Opposition contrôlée à chaque transition, jamais une seule fois.
 *     Empreinte HMAC-SHA-256 versionnée, secret jamais stocké en base.
 *  4. Relance bornée à une seule, côté service ET côté base.
 *  5. Rôle administrateur vérifié dans la transaction : la clé étrangère
 *     prouve que le compte existe, pas qu'il est actif ni administrateur.
 *
 * Ce module n'importe aucun client d'envoi de courriel. C'est délibéré : c'est
 * la garantie architecturale qui complète l'invariant delivery_allowed = false.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, count, eq, isNull, lt, sql } from "drizzle-orm";

import {
  db,
  novaluthPlatformAccountsTable,
  prospectionDossiers,
  prospectionJournal,
  prospectionOppositions,
  prospectionProposals,
  PROSPECTION_HMAC_VERSION,
  PROSPECTION_TRANSITIONS,
  PROSPECTION_TERMINAL_STATES,
  PROSPECTION_MAX_FOLLOW_UPS,
  PROSPECTION_FOLLOW_UP_AFTER_DAYS,
  PROSPECTION_CLOSE_AFTER_DAYS,
  PROSPECTION_MAX_SIGNALS,
  PROSPECTION_MAX_SIGNAL_LENGTH,
  isProspectionTransitionAllowed,
  type ProspectionDossier,
  type ProspectionEvent,
  type ProspectionOppositionOrigin,
  type ProspectionProposalKind,
  type ProspectionReason,
  type ProspectionState,
} from "@workspace/db";

type Database = typeof db;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;

/* -------------------------------------------------------------------------- */
/* 1. Erreurs métier                                                          */
/* -------------------------------------------------------------------------- */

export class TransitionRefused extends Error {
  readonly code = "transition_refused";
  constructor(message: string) {
    super(message);
    this.name = "TransitionRefused";
  }
}

export class OppositionActive extends Error {
  readonly code = "opposition_active";
  constructor(message = "Adresse en opposition : aucune action possible") {
    super(message);
    this.name = "OppositionActive";
  }
}

export class DossierLocked extends Error {
  readonly code = "dossier_locked";
  constructor(message = "Ce dossier est en cours de traitement par un autre opérateur") {
    super(message);
    this.name = "DossierLocked";
  }
}

export class AdminRequired extends Error {
  readonly code = "admin_required";
  constructor(message = "Compte administrateur actif requis") {
    super(message);
    this.name = "AdminRequired";
  }
}

/* -------------------------------------------------------------------------- */
/* 2. Empreinte HMAC — convention figée par le schéma                         */
/* -------------------------------------------------------------------------- */

/**
 * Trousseau de secrets, indexé par version d'empreinte.
 *
 * Variables d'environnement attendues :
 *   PROSPECTION_HMAC_SECRET_V1  (obligatoire)
 *   PROSPECTION_HMAC_SECRET_V2  (à la rotation, la version courante)
 *
 * Les anciens secrets sont conservés le temps que les oppositions historiques
 * restent opposables. Aucun secret n'est jamais écrit en base ni journalisé.
 */
function keyring(): Map<number, string> {
  const ring = new Map<number, string>();
  for (let version = 1; version <= 9; version += 1) {
    const secret = process.env[`PROSPECTION_HMAC_SECRET_V${version}`]?.trim();
    if (secret) ring.set(version, secret);
  }
  if (ring.size === 0) {
    throw new Error(
      "PROSPECTION_HMAC_SECRET_V1 est requis : aucune empreinte d'opposition ne peut être calculée.",
    );
  }
  return ring;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;

/**
 * Procédure figée par le schéma, version 1 :
 * espaces retirés, minuscules, syntaxe validée, UTF-8, HMAC-SHA-256,
 * hexadécimal minuscule.
 *
 * Une adresse invalide est REFUSÉE, jamais hachée.
 */
export function fingerprint(email: string, version = PROSPECTION_HMAC_VERSION): string {
  const normalised = (email ?? "").trim().toLowerCase();
  if (!EMAIL_SHAPE.test(normalised)) {
    throw new TransitionRefused(`Adresse invalide : elle ne peut pas être empreintée`);
  }
  const secret = keyring().get(version);
  if (!secret) {
    throw new Error(`Aucun secret disponible pour la version d'empreinte ${version}`);
  }
  return createHmac("sha256", secret).update(normalised, "utf8").digest("hex");
}

/** Versions actives, de la plus récente à la plus ancienne. */
export function activeVersions(): number[] {
  return [...keyring().keys()].sort((a, b) => b - a);
}

/**
 * Vrai si l'adresse figure en opposition, pour l'une quelconque des versions
 * d'empreinte actives. Le contrôle porte sur toutes les versions : une rotation
 * de secret ne fait pas réapparaître une adresse retirée.
 */
export async function isOpposed(
  email: string | null | undefined,
  executor: Executor = db,
): Promise<boolean> {
  if (!email) return false;

  for (const version of activeVersions()) {
    let hmac: string;
    try {
      hmac = fingerprint(email, version);
    } catch {
      return false; // adresse invalide : rien à comparer
    }
    const [row] = await executor
      .select({ hmac: prospectionOppositions.emailHmac })
      .from(prospectionOppositions)
      .where(
        and(
          eq(prospectionOppositions.emailHmac, hmac),
          eq(prospectionOppositions.hmacVersion, version),
        ),
      )
      .limit(1);
    if (row) return true;
  }
  return false;
}

/** Comparaison à temps constant, pour les jetons d'administration. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a ?? "", "utf8");
  const right = Buffer.from(b ?? "", "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* -------------------------------------------------------------------------- */
/* 3. Journal caviardé                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Écrit une ligne de journal. La signature n'accepte aucune chaîne libre :
 * seuls des vocabulaires fermés, un slug et un entier. Le slug provient
 * toujours du dossier chargé dans la transaction, jamais d'une requête cliente.
 */
export async function journal(
  tx: Executor,
  entry: {
    dossierId?: string | null;
    slug?: string | null;
    event: ProspectionEvent;
    stateBefore?: ProspectionState | null;
    stateAfter?: ProspectionState | null;
    reason?: ProspectionReason | null;
    measure?: number | null;
  },
): Promise<void> {
  await tx.insert(prospectionJournal).values({
    dossierId: entry.dossierId ?? null,
    slug: entry.slug ?? null,
    event: entry.event,
    stateBefore: entry.stateBefore ?? null,
    stateAfter: entry.stateAfter ?? null,
    reason: entry.reason ?? null,
    measure: entry.measure ?? null,
  });
}

/* -------------------------------------------------------------------------- */
/* 4. Verrous consultatifs — réponse à la tâche #89                           */
/* -------------------------------------------------------------------------- */

async function firstRow<T>(result: unknown): Promise<T | undefined> {
  const rows = (result as { rows?: T[] })?.rows ?? (result as T[]);
  return Array.isArray(rows) ? rows[0] : undefined;
}

/**
 * Verrou consultatif TRANSACTIONNEL sur un dossier. Libéré automatiquement à la
 * fin de la transaction, y compris en cas d'erreur ou de coupure de connexion :
 * aucun verrou ne peut rester coincé.
 *
 * C'est ce mécanisme qui empêche deux opérateurs de préparer ou de proposer le
 * même atelier en même temps.
 */
async function lockDossier(tx: Executor, dossierId: string): Promise<boolean> {
  const result = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`prospection:dossier:${dossierId}`}, 0)) AS locked`,
  );
  const row = await firstRow<{ locked: boolean }>(result);
  return Boolean(row?.locked);
}

/** Verrou nommé pour un traitement planifié. */
export async function withJobLock<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  return db.transaction(async (tx) => {
    const result = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`prospection:job:${name}`}, 0)) AS locked`,
    );
    const row = await firstRow<{ locked: boolean }>(result);
    if (!row?.locked) {
      await journal(tx, { event: "lock_contended" });
      return null;
    }
    return run();
  });
}

/* -------------------------------------------------------------------------- */
/* 5. Contrôle du compte administrateur                                       */
/* -------------------------------------------------------------------------- */

/**
 * Vérifie que le compte existe, est actif et porte le rôle administrateur.
 *
 * La clé étrangère du schéma garantit seulement l'existence. Le rôle ne peut pas
 * être contrôlé par une contrainte de ligne, il l'est donc ici, DANS la
 * transaction qui écrit.
 *
 * ⚠️ ADAPTER les noms de colonnes de rôle et d'état actif à votre table réelle.
 */
export async function assertActiveAdmin(tx: Executor, accountId: number): Promise<void> {
  const [account] = await tx
    .select()
    .from(novaluthPlatformAccountsTable)
    .where(eq(novaluthPlatformAccountsTable.id, accountId))
    .limit(1);

  if (!account) throw new AdminRequired("Compte introuvable");

  const record = account as Record<string, unknown>;
  const role = String(record.role ?? record.accountRole ?? "").toLowerCase();
  if (role !== "admin") throw new AdminRequired("Ce compte n'a pas le rôle administrateur");

  const inactive =
    record.isActive === false ||
    record.active === false ||
    record.disabledAt != null ||
    record.deletedAt != null ||
    record.revokedAt != null;
  if (inactive) throw new AdminRequired("Ce compte n'est pas actif");
}

/* -------------------------------------------------------------------------- */
/* 6. Transition                                                              */
/* -------------------------------------------------------------------------- */

const TIMESTAMP_BY_STATE: Partial<Record<ProspectionState, string>> = {
  verified: "verifiedAt",
  proposed: "proposedAt",
  sent: "sentAt",
  followed_up: "followedUpAt",
  replied: "repliedAt",
};

export interface TransitionOptions {
  target: ProspectionState;
  reason?: ProspectionReason;
  expectedState?: ProspectionState;
  expectedRevision?: number;
  /** Réutilise une transaction ouverte, pour composer plusieurs écritures. */
  tx?: Transaction;
  /** Ignore le contrôle d'opposition. Réservé à la transition vers « opposed ». */
  skipOppositionCheck?: boolean;
}

/**
 * Applique une transition, ou lève une erreur explicite. Idempotente lorsque la
 * cible est déjà l'état courant.
 */
export async function transition(
  dossierId: string,
  options: TransitionOptions,
): Promise<ProspectionDossier> {
  const run = async (tx: Transaction): Promise<ProspectionDossier> => {
    if (!(await lockDossier(tx, dossierId))) {
      await journal(tx, { dossierId, event: "lock_contended" });
      throw new DossierLocked();
    }

    const [current] = await tx
      .select()
      .from(prospectionDossiers)
      .where(eq(prospectionDossiers.id, dossierId))
      .limit(1);
    if (!current) throw new TransitionRefused(`Dossier introuvable : ${dossierId}`);

    const from = current.state as ProspectionState;
    const to = options.target;

    if (options.expectedState && from !== options.expectedState) {
      throw new TransitionRefused(
        `Dossier en « ${from} », transition attendue depuis « ${options.expectedState} »`,
      );
    }
    if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
      throw new TransitionRefused("Le dossier a été modifié entre-temps : transition annulée");
    }
    if (to === from) return current;
    if (!isProspectionTransitionAllowed(from, to)) {
      throw new TransitionRefused(`« ${from} » → « ${to} » n'est pas une transition permise`);
    }
    if (to === "followed_up" && current.followUpCount >= PROSPECTION_MAX_FOLLOW_UPS) {
      throw new TransitionRefused("Ce dossier a déjà été relancé : aucune seconde relance");
    }
    // Opposition contrôlée à CHAQUE transition, jamais une seule fois.
    if (
      to !== "opposed" &&
      !options.skipOppositionCheck &&
      (await isOpposed(current.contactEmail, tx))
    ) {
      throw new OppositionActive();
    }

    const now = new Date();
    const patch: Record<string, unknown> = {
      state: to,
      lastReason: options.reason ?? null,
      revision: sql`${prospectionDossiers.revision} + 1`,
    };
    const stamp = TIMESTAMP_BY_STATE[to];
    if (stamp) patch[stamp] = now;
    if (to === "followed_up") {
      patch.followUpCount = sql`${prospectionDossiers.followUpCount} + 1`;
    }
    if (PROSPECTION_TERMINAL_STATES.includes(to)) patch.closedAt = now;
    // Un dossier qui revient à la vie n'est plus clos.
    if (!PROSPECTION_TERMINAL_STATES.includes(to) && current.closedAt) patch.closedAt = null;

    const updated = await tx
      .update(prospectionDossiers)
      .set(patch)
      .where(
        and(
          eq(prospectionDossiers.id, dossierId),
          eq(prospectionDossiers.state, from),
          eq(prospectionDossiers.revision, current.revision),
        ),
      )
      .returning();

    if (updated.length !== 1) {
      throw new TransitionRefused("Écriture concurrente détectée : transition annulée");
    }

    // Même transaction que la transition : pas d'état sans trace.
    await journal(tx, {
      dossierId,
      slug: current.slug,
      event: "state_changed",
      stateBefore: from,
      stateAfter: to,
      reason: options.reason ?? null,
    });

    return updated[0];
  };

  return options.tx ? run(options.tx) : db.transaction(run);
}

/* -------------------------------------------------------------------------- */
/* 7. Opposition — irréversible                                               */
/* -------------------------------------------------------------------------- */

/**
 * Enregistre une opposition définitive et clôt, dans la MÊME transaction, tout
 * dossier portant cette adresse ainsi que ses propositions actives.
 *
 * Il n'existe volontairement aucune fonction inverse : une opposition ne se lève
 * pas depuis le code.
 */
export async function recordOpposition(input: {
  email: string;
  origin: ProspectionOppositionOrigin;
}): Promise<{ closedDossiers: number; withdrawnProposals: number }> {
  const version = PROSPECTION_HMAC_VERSION;
  const hmac = fingerprint(input.email, version);

  return db.transaction(async (tx) => {
    await tx
      .insert(prospectionOppositions)
      .values({ emailHmac: hmac, hmacVersion: version, origin: input.origin })
      .onConflictDoNothing();

    // On ne peut pas comparer une empreinte en SQL sans stocker l'adresse :
    // on charge les dossiers porteurs d'une adresse et on compare en mémoire.
    const dossiers = await tx
      .select({
        id: prospectionDossiers.id,
        slug: prospectionDossiers.slug,
        state: prospectionDossiers.state,
        email: prospectionDossiers.contactEmail,
      })
      .from(prospectionDossiers)
      .where(sql`${prospectionDossiers.contactEmail} IS NOT NULL`);

    let closedDossiers = 0;
    let withdrawnProposals = 0;

    for (const dossier of dossiers) {
      if (!dossier.email) continue;
      let candidate: string;
      try {
        candidate = fingerprint(dossier.email, version);
      } catch {
        continue;
      }
      if (candidate !== hmac) continue;
      if (dossier.state === "opposed") continue;

      const withdrawn = await tx
        .update(prospectionProposals)
        .set({ withdrawnAt: new Date() })
        .where(
          and(
            eq(prospectionProposals.dossierId, dossier.id),
            isNull(prospectionProposals.withdrawnAt),
          ),
        )
        .returning({ id: prospectionProposals.id });
      withdrawnProposals += withdrawn.length;

      await transition(dossier.id, {
        target: "opposed",
        reason: "opposition_active",
        skipOppositionCheck: true,
        tx,
      });
      closedDossiers += 1;
    }

    await journal(tx, {
      event: "opposition_recorded",
      reason: "opposition_active",
      measure: closedDossiers,
    });
    return { closedDossiers, withdrawnProposals };
  });
}

/* -------------------------------------------------------------------------- */
/* 8. Accroche et file proposée                                               */
/* -------------------------------------------------------------------------- */

const HOOK_PLACEHOLDER = "[À compléter";

/**
 * Enregistre l'accroche relue par un administrateur et passe le dossier en
 * « draft_ready ». L'origine de PRODUCTION n'est pas modifiée : une accroche
 * produite par l'IA garde `hookOrigin = 'ai'` tout en étant validée.
 */
export async function validateHook(
  dossierId: string,
  input: { hook: string; accountId: number },
): Promise<ProspectionDossier> {
  const hook = (input.hook ?? "").trim();
  if (hook.length < 40) throw new TransitionRefused("Accroche trop courte");
  if (hook.length > 2000) throw new TransitionRefused("Accroche trop longue");
  if (hook.includes(HOOK_PLACEHOLDER)) {
    throw new TransitionRefused(
      "L'accroche contient encore le marqueur « À compléter » : écrivez la phrase personnelle avant de valider",
    );
  }

  return db.transaction(async (tx) => {
    await assertActiveAdmin(tx, input.accountId);

    const [before] = await tx
      .select()
      .from(prospectionDossiers)
      .where(eq(prospectionDossiers.id, dossierId))
      .limit(1);
    if (!before) throw new TransitionRefused("Dossier introuvable");

    await tx
      .update(prospectionDossiers)
      .set({
        hook,
        hookValidatedAt: new Date(),
        hookValidatedByAccountId: input.accountId,
      })
      .where(eq(prospectionDossiers.id, dossierId));

    const dossier = await transition(dossierId, {
      target: "draft_ready",
      reason: "human_validation",
      expectedState: "verified",
      tx,
    });

    await journal(tx, {
      dossierId,
      slug: dossier.slug,
      event: "hook_validated",
      reason: "human_validation",
      measure: hook.length,
    });
    return dossier;
  });
}

/**
 * Seule porte d'entrée de la file proposée.
 *
 * N'écrit JAMAIS dans l'outbox transactionnel d'expédition. Le destinataire est
 * figé par empreinte au moment de la validation : si l'adresse du dossier change
 * ensuite, la proposition ne correspond plus et doit être revalidée.
 */
export async function proposeForSending(
  dossierId: string,
  input: {
    subject: string;
    body: string;
    accountId: number;
    kind?: ProspectionProposalKind;
  },
): Promise<ProspectionDossier> {
  const subject = (input.subject ?? "").trim();
  const body = (input.body ?? "").trim();
  if (subject.length < 10 || subject.length > 200) {
    throw new TransitionRefused("Objet du message hors bornes (10 à 200 caractères)");
  }
  if (body.length < 200 || body.length > 8000) {
    throw new TransitionRefused("Corps du message hors bornes (200 à 8000 caractères)");
  }
  if (body.includes(HOOK_PLACEHOLDER)) {
    throw new TransitionRefused("Le message contient encore le marqueur « À compléter »");
  }

  return db.transaction(async (tx) => {
    await assertActiveAdmin(tx, input.accountId);

    const [dossier] = await tx
      .select()
      .from(prospectionDossiers)
      .where(eq(prospectionDossiers.id, dossierId))
      .limit(1);
    if (!dossier) throw new TransitionRefused("Dossier introuvable");
    if (!dossier.contactEmail) throw new TransitionRefused("Adresse de contact absente");
    if (!dossier.hook) throw new TransitionRefused("Accroche absente");
    if (await isOpposed(dossier.contactEmail, tx)) throw new OppositionActive();

    const kind = input.kind ?? "first_contact";
    const recipientHmac = fingerprint(dossier.contactEmail);

    await tx
      .insert(prospectionProposals)
      .values({
        dossierId,
        kind,
        subject,
        body,
        recipientHmac,
        recipientHmacVersion: PROSPECTION_HMAC_VERSION,
        validatedByAccountId: input.accountId,
        deliveryAllowed: false,
      })
      .onConflictDoUpdate({
        target: [prospectionProposals.dossierId, prospectionProposals.kind],
        set: {
          subject,
          body,
          recipientHmac,
          recipientHmacVersion: PROSPECTION_HMAC_VERSION,
          validatedByAccountId: input.accountId,
          validatedAt: new Date(),
          withdrawnAt: null,
        },
        setWhere: isNull(prospectionProposals.withdrawnAt),
      });

    const updated = await transition(dossierId, {
      target: "proposed",
      reason: "human_validation",
      expectedState: "draft_ready",
      tx,
    });

    await journal(tx, {
      dossierId,
      slug: dossier.slug,
      event: "queued",
      reason: "human_validation",
    });
    return updated;
  });
}

export async function withdrawProposal(
  dossierId: string,
  accountId: number,
): Promise<ProspectionDossier> {
  return db.transaction(async (tx) => {
    await assertActiveAdmin(tx, accountId);

    await tx
      .update(prospectionProposals)
      .set({ withdrawnAt: new Date() })
      .where(
        and(
          eq(prospectionProposals.dossierId, dossierId),
          isNull(prospectionProposals.withdrawnAt),
        ),
      );

    const dossier = await transition(dossierId, {
      target: "draft_ready",
      reason: "removed_from_queue",
      expectedState: "proposed",
      tx,
    });

    await journal(tx, {
      dossierId,
      slug: dossier.slug,
      event: "dequeued",
      reason: "removed_from_queue",
    });
    return dossier;
  });
}

/**
 * Vérifie que la proposition active correspond toujours à l'adresse du dossier.
 * Si l'adresse a changé depuis la validation, la proposition est retirée et le
 * dossier revient en « draft_ready » : une nouvelle validation humaine est
 * exigée.
 */
export async function revalidateRecipient(dossierId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [dossier] = await tx
      .select()
      .from(prospectionDossiers)
      .where(eq(prospectionDossiers.id, dossierId))
      .limit(1);
    if (!dossier?.contactEmail) return false;

    const [proposal] = await tx
      .select()
      .from(prospectionProposals)
      .where(
        and(
          eq(prospectionProposals.dossierId, dossierId),
          isNull(prospectionProposals.withdrawnAt),
        ),
      )
      .limit(1);
    if (!proposal) return false;

    const current = fingerprint(dossier.contactEmail, proposal.recipientHmacVersion);
    if (current === proposal.recipientHmac) return false;

    await tx
      .update(prospectionProposals)
      .set({ withdrawnAt: new Date() })
      .where(eq(prospectionProposals.id, proposal.id));

    if (dossier.state === "proposed") {
      await transition(dossierId, {
        target: "draft_ready",
        reason: "removed_from_queue",
        tx,
      });
    }
    await journal(tx, {
      dossierId,
      slug: dossier.slug,
      event: "dequeued",
      reason: "removed_from_queue",
    });
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* 9. Validation des indices — règle de service                               */
/* -------------------------------------------------------------------------- */

/**
 * La base plafonne le NOMBRE d'indices ; la longueur de chacun ne s'exprime pas
 * simplement en SQL sans fonction auxiliaire. Elle est donc imposée ici.
 */
export function sanitiseSignals(signals: readonly string[]): string[] {
  const cleaned: string[] = [];
  for (const raw of signals) {
    const value = (raw ?? "").trim();
    if (!value) continue;
    if (value.length > PROSPECTION_MAX_SIGNAL_LENGTH) {
      throw new TransitionRefused(
        `Indice trop long (${value.length} caractères, maximum ${PROSPECTION_MAX_SIGNAL_LENGTH})`,
      );
    }
    cleaned.push(value);
    if (cleaned.length > PROSPECTION_MAX_SIGNALS) {
      throw new TransitionRefused(`Plus de ${PROSPECTION_MAX_SIGNALS} indices`);
    }
  }
  return cleaned;
}

/* -------------------------------------------------------------------------- */
/* 10. Échéances — calculées ici, appliquées au lot 3                         */
/* -------------------------------------------------------------------------- */

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

export async function dossiersDueForFollowUp(): Promise<ProspectionDossier[]> {
  return db
    .select()
    .from(prospectionDossiers)
    .where(
      and(
        eq(prospectionDossiers.state, "sent"),
        lt(prospectionDossiers.sentAt, daysAgo(PROSPECTION_FOLLOW_UP_AFTER_DAYS)),
        lt(prospectionDossiers.followUpCount, PROSPECTION_MAX_FOLLOW_UPS),
      ),
    );
}

export async function dossiersDueForClosing(): Promise<ProspectionDossier[]> {
  return db
    .select()
    .from(prospectionDossiers)
    .where(
      and(
        eq(prospectionDossiers.state, "followed_up"),
        lt(
          prospectionDossiers.followedUpAt,
          daysAgo(PROSPECTION_CLOSE_AFTER_DAYS - PROSPECTION_FOLLOW_UP_AFTER_DAYS),
        ),
      ),
    );
}

/* -------------------------------------------------------------------------- */
/* 11. Diagnostic                                                             */
/* -------------------------------------------------------------------------- */

export async function diagnose() {
  const [orphans] = await db
    .select({ n: count() })
    .from(prospectionProposals)
    .leftJoin(prospectionDossiers, eq(prospectionDossiers.id, prospectionProposals.dossierId))
    .where(
      and(
        isNull(prospectionProposals.withdrawnAt),
        sql`${prospectionDossiers.state} IS NULL OR ${prospectionDossiers.state} NOT IN ('proposed','sent','followed_up','replied','enrolled')`,
      ),
    );

  const [deliverable] = await db
    .select({ n: count() })
    .from(prospectionProposals)
    .where(eq(prospectionProposals.deliveryAllowed, true));

  const [overCap] = await db
    .select({ n: count() })
    .from(prospectionDossiers)
    .where(sql`${prospectionDossiers.followUpCount} > ${PROSPECTION_MAX_FOLLOW_UPS}`);

  const [oppositions] = await db.select({ n: count() }).from(prospectionOppositions);
  const [activeProposals] = await db
    .select({ n: count() })
    .from(prospectionProposals)
    .where(isNull(prospectionProposals.withdrawnAt));

  const followUp = await dossiersDueForFollowUp();
  const closing = await dossiersDueForClosing();

  const report = {
    lot: "1B — service transactionnel",
    aiEnabled: false,
    interactiveTelegramEnabled: false,
    automaticFollowUpsEnabled: false,
    realDeliveryEnabled: false,
    declaredStates: Object.keys(PROSPECTION_TRANSITIONS).length,
    hmacVersionsActive: activeVersions(),
    proposalsWithoutValidState: Number(orphans?.n ?? 0),
    proposalsWithDeliveryAllowed: Number(deliverable?.n ?? 0),
    followUpsAboveCap: Number(overCap?.n ?? 0),
    oppositionsRecorded: Number(oppositions?.n ?? 0),
    activeProposals: Number(activeProposals?.n ?? 0),
    dueForFollowUp: followUp.length,
    dueForClosing: closing.length,
    foundationHealthy: false,
  };

  report.foundationHealthy =
    report.proposalsWithoutValidState === 0 &&
    report.proposalsWithDeliveryAllowed === 0 &&
    report.followUpsAboveCap === 0 &&
    report.hmacVersionsActive.length > 0;

  return report;
}
