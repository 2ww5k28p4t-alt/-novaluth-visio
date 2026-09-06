/**
 * Novaluth — Prospection des ateliers · LOT 1A : schéma seul
 * ==========================================================
 *
 * Emplacement : lib/db/src/schema/novaluth-prospection.ts
 * Réexport    : export * from "./novaluth-prospection";  dans schema/index.ts
 *
 * Version 2 — révisée après revue technique. Changements notables :
 *   · les quatre pgEnum sont remplacés par des colonnes text + contraintes
 *     CHECK, conformément à la convention du projet et à la note de mémoire
 *     development-check-constraints ;
 *   · les valeurs autorisées vivent dans des tableaux TypeScript `as const`,
 *     source de vérité unique pour la base et pour le service ;
 *   · contraintes de cohérence entre état, compteurs et horodatages ;
 *   · signal_count supprimé au profit de cardinality(verified_signals) ;
 *   · empreinte HMAC-SHA-256 et non SHA-256 nu ;
 *   · destinataire figé dans la proposition ;
 *   · suppression en RESTRICT pour ne pas effacer une preuve de validation ;
 *   · identité humaine imposée par format, non par liste d'exclusions.
 *
 * PÉRIMÈTRE DU LOT 1A
 * -------------------
 * Ce fichier ne contient que des données et des invariants de ligne. Il ne
 * contient ni service, ni route, ni worker.
 *
 * ⚠️ CE QUE CE SCHÉMA GARANTIT, ET CE QU'IL NE GARANTIT PAS
 * ---------------------------------------------------------
 * Garanti par PostgreSQL, sur chaque ligne, quelle que soit l'origine de
 * l'écriture :
 *   · les valeurs d'état, de motif, d'événement et d'origine sont dans une
 *     liste fermée ;
 *   · le compteur de relance ne peut valoir que 0 ou 1 ;
 *   · un état donné exige les horodatages correspondants, dans un ordre
 *     chronologique cohérent ;
 *   · une proposition porte un destinataire figé et un acteur humain au format
 *     imposé ;
 *   · delivery_allowed ne peut pas être mis à vrai ;
 *   · l'empreinte d'opposition a la forme d'une empreinte, jamais d'une adresse ;
 *   · le journal n'accepte aucun texte libre.
 *
 * NON garanti par ce schéma, et devant l'être ailleurs :
 *   · la légalité d'une TRANSITION d'état. PROSPECTION_TRANSITIONS est une
 *     règle applicative : un `UPDATE ... SET state = 'enrolled'` direct
 *     réussirait. La garantie repose sur le service transactionnel du lot 1B,
 *     qui doit être le seul détenteur du droit d'écriture, et sur une mise à
 *     jour conditionnée par (id, state, revision). Un trigger PostgreSQL peut
 *     être ajouté plus tard si la garantie doit exister au niveau de la base.
 *   · l'immuabilité du journal. Il est append-only par convention
 *     transactionnelle : UPDATE et DELETE restent techniquement possibles.
 *     À verrouiller par les permissions du rôle applicatif, ou par un trigger.
 *   · l'absence d'envoi réel. La contrainte delivery_allowed = false empêche
 *     l'activation accidentelle du champ ; l'absence d'envoi dépend AUSSI de
 *     la règle d'architecture interdisant tout worker de lecture de
 *     subject/body vers le service d'expédition.
 */

import { sql, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------- */
/* 1. Vocabulaires fermés — source de vérité unique                           */
/* -------------------------------------------------------------------------- */

/** États du dossier. Ajouter une valeur ne demande aucune migration d'enum. */
export const PROSPECTION_STATES = [
  "opened", // dossier ouvert, page pas encore lue
  "verified", // cohérence validée, accroche mécanique déjà générée
  "draft_ready", // accroche relue et validée par une personne
  "proposed", // message validé, en file proposée
  "sent", // premier contact expédié, marqué à la main au lot 1
  "followed_up", // relancé, au plus une fois
  "replied",
  "enrolled",
  "declined",
  "no_reply",
  "inconsistent", // cohérence refusée, fiche à corriger
  "no_website",
  "opposed", // terminal, irréversible
  "abandoned",
] as const;

export const PROSPECTION_REASONS = [
  "name_absent_from_page",
  "city_absent_from_page",
  "insufficient_signals",
  "page_too_short",
  "read_refused",
  "gateway_unavailable",
  "no_website",
  "opposition_active",
  "missing_hook",
  "already_proposed",
  "human_validation",
  "removed_from_queue",
  "record_corrected",
  "silence_after_follow_up",
  "human_decision",
  "uncoded_reason",
] as const;

export const PROSPECTION_EVENTS = [
  "dossier_opened",
  "page_read",
  "coherence_accepted",
  "coherence_refused",
  "hook_validated",
  "state_changed",
  "queued",
  "dequeued",
  "opposition_recorded",
  "lock_contended",
] as const;

/** « ai » est déclaré dès maintenant : le lot 2 n'exigera aucune migration. */
export const PROSPECTION_HOOK_ORIGINS = ["signals", "human", "ai"] as const;

/** Type de message proposé. Contraint, pour ne pas fragiliser l'unicité. */
export const PROSPECTION_PROPOSAL_KINDS = ["first_contact", "follow_up"] as const;

/** Origine d'une opposition. Fermée, pour interdire toute donnée libre. */
export const PROSPECTION_OPPOSITION_ORIGINS = [
  "email_reply",
  "admin_entry",
  "telegram_callback",
  "unsubscribe_request",
] as const;

export type ProspectionState = (typeof PROSPECTION_STATES)[number];
export type ProspectionReason = (typeof PROSPECTION_REASONS)[number];
export type ProspectionEvent = (typeof PROSPECTION_EVENTS)[number];
export type ProspectionHookOrigin = (typeof PROSPECTION_HOOK_ORIGINS)[number];
export type ProspectionProposalKind = (typeof PROSPECTION_PROPOSAL_KINDS)[number];
export type ProspectionOppositionOrigin = (typeof PROSPECTION_OPPOSITION_ORIGINS)[number];

/* -------------------------------------------------------------------------- */
/* 2. Fabriques de contraintes                                                */
/* -------------------------------------------------------------------------- */

/** `colonne IN ('a', 'b', …)` — les valeurs sont paramétrées, jamais concaténées. */
function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

/** `colonne IS NULL OR colonne IN (…)` */
function nullOrOneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IS NULL OR ${oneOf(column, values)}`;
}

/** Implication : si l'état est dans `states`, alors `then` doit être vrai. */
function whenState(
  column: AnyPgColumn,
  states: readonly ProspectionState[],
  then: SQL,
): SQL {
  return sql`NOT (${oneOf(column, states)}) OR (${then})`;
}

/** Empreinte HMAC-SHA-256 en hexadécimal minuscule. */
const HEX64 = "^[0-9a-f]{64}$";

/** Identifiant d'acteur administrateur, produit par l'authentification serveur. */
const ADMIN_ACTOR = "^admin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** Slug d'annuaire : minuscules, chiffres, tirets. Interdit toute adresse. */
const SLUG = "^[a-z0-9]([a-z0-9-]{0,118}[a-z0-9])?$";

const TERMINAL: readonly ProspectionState[] = [
  "enrolled",
  "declined",
  "no_reply",
  "opposed",
  "abandoned",
];

/* -------------------------------------------------------------------------- */
/* 3. Dossier de prospection                                                  */
/* -------------------------------------------------------------------------- */

export const prospectionDossiers = pgTable(
  "prospection_dossiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Slug de la fiche de l'annuaire.
     *
     * ⚠️ À CÂBLER : une clé étrangère vers la colonne slug de la table des
     * profils Novaluth, en onDelete: "restrict", afin d'interdire les dossiers
     * orphelins. Elle n'est pas déclarée ici parce qu'elle exige que la colonne
     * cible porte une contrainte d'unicité ; à vérifier avant de l'ajouter.
     *
     * Tant que la clé étrangère n'existe pas, le service doit refuser d'ouvrir
     * un dossier pour un slug absent de l'annuaire.
     */
    slug: text("slug").notNull(),

    workshopName: text("workshop_name").notNull(),
    websiteUrl: text("website_url"),

    /**
     * Adresse professionnelle publique relevée sur le site de l'atelier.
     * Nécessaire à l'exploitation ; l'opposition se contrôle par comparaison
     * d'empreintes HMAC calculées par le service, jamais par jointure SQL.
     */
    contactEmail: text("contact_email"),
    contactFirstName: text("contact_first_name"),

    state: text("state").notNull().default("opened"),
    lastReason: text("last_reason"),

    hook: text("hook"),
    hookOrigin: text("hook_origin"),

    /**
     * Indices de cohérence retrouvés sur la page de l'atelier. Faits publics,
     * donc conservés en clair. Leur nombre s'obtient par
     * cardinality(verified_signals) : aucun compteur redondant n'est stocké.
     */
    verifiedSignals: text("verified_signals")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /** Borné à 0 ou 1 : « relance exactement une fois ». */
    followUpCount: integer("follow_up_count").notNull().default(0),

    /** Verrouillage optimiste. Le service incrémente à chaque transition. */
    revision: integer("revision").notNull().default(0),

    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    proposedAt: timestamp("proposed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    followedUpAt: timestamp("followed_up_at", { withTimezone: true }),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("prospection_dossiers_slug_key").on(table.slug),
    index("prospection_dossiers_state_idx").on(table.state),
    index("prospection_dossiers_sent_at_idx").on(table.sentAt),

    /* --- vocabulaires ---------------------------------------------------- */
    check("prospection_dossiers_state_known", oneOf(table.state, PROSPECTION_STATES)),
    check(
      "prospection_dossiers_reason_known",
      nullOrOneOf(table.lastReason, PROSPECTION_REASONS),
    ),
    check(
      "prospection_dossiers_hook_origin_known",
      nullOrOneOf(table.hookOrigin, PROSPECTION_HOOK_ORIGINS),
    ),
    check("prospection_dossiers_slug_format", sql`${table.slug} ~ ${SLUG}`),

    /* --- relance : exactement une fois ----------------------------------- */
    check(
      "prospection_dossiers_follow_up_capped",
      sql`${table.followUpCount} BETWEEN 0 AND 1`,
    ),
    // Un compteur à 1 exige la date correspondante.
    check(
      "prospection_dossiers_follow_up_needs_date",
      sql`${table.followUpCount} = 0 OR ${table.followedUpAt} IS NOT NULL`,
    ),
    // Une date de relance exige le compteur correspondant.
    check(
      "prospection_dossiers_follow_up_date_needs_count",
      sql`${table.followedUpAt} IS NULL OR ${table.followUpCount} = 1`,
    ),
    // Avant l'envoi, aucune relance n'a pu avoir lieu.
    check(
      "prospection_dossiers_no_early_follow_up",
      whenState(
        table.state,
        ["opened", "verified", "draft_ready", "proposed", "sent", "inconsistent", "no_website"],
        sql`${table.followUpCount} = 0`,
      ),
    ),
    check(
      "prospection_dossiers_followed_up_is_consistent",
      whenState(
        table.state,
        ["followed_up"],
        sql`${table.followUpCount} = 1 AND ${table.followedUpAt} IS NOT NULL`,
      ),
    ),

    /* --- accroche : générée avant l'entrée dans « verified » -------------- */
    check(
      "prospection_dossiers_hook_required",
      whenState(
        table.state,
        ["verified", "draft_ready", "proposed", "sent", "followed_up"],
        sql`${table.hook} IS NOT NULL AND ${table.hookOrigin} IS NOT NULL`,
      ),
    ),
    // Une accroche relue par une personne implique l'origine « human ».
    check(
      "prospection_dossiers_draft_ready_is_human",
      whenState(table.state, ["draft_ready", "proposed", "sent", "followed_up"], sql`${table.hookOrigin} = 'human'`),
    ),

    /* --- adresse de contact ---------------------------------------------- */
    check(
      "prospection_dossiers_contact_required",
      whenState(
        table.state,
        ["proposed", "sent", "followed_up"],
        sql`${table.contactEmail} IS NOT NULL`,
      ),
    ),

    /* --- horodatages exigés par l'état ----------------------------------- */
    check(
      "prospection_dossiers_verified_at_required",
      whenState(
        table.state,
        ["verified", "draft_ready", "proposed", "sent", "followed_up"],
        sql`${table.verifiedAt} IS NOT NULL`,
      ),
    ),
    check(
      "prospection_dossiers_proposed_at_required",
      whenState(
        table.state,
        ["proposed", "sent", "followed_up"],
        sql`${table.proposedAt} IS NOT NULL`,
      ),
    ),
    check(
      "prospection_dossiers_sent_at_required",
      whenState(table.state, ["sent", "followed_up"], sql`${table.sentAt} IS NOT NULL`),
    ),
    check(
      "prospection_dossiers_replied_at_required",
      whenState(table.state, ["replied", "enrolled"], sql`${table.repliedAt} IS NOT NULL`),
    ),
    check(
      "prospection_dossiers_closed_at_required",
      whenState(table.state, TERMINAL, sql`${table.closedAt} IS NOT NULL`),
    ),
    // Un dossier encore vivant n'est pas clos.
    check(
      "prospection_dossiers_open_has_no_closed_at",
      whenState(
        table.state,
        ["opened", "verified", "draft_ready", "proposed", "sent", "followed_up", "replied"],
        sql`${table.closedAt} IS NULL`,
      ),
    ),

    /* --- chronologie ------------------------------------------------------ */
    check(
      "prospection_dossiers_chronology_verified",
      sql`${table.verifiedAt} IS NULL OR ${table.verifiedAt} >= ${table.openedAt}`,
    ),
    check(
      "prospection_dossiers_chronology_proposed",
      sql`${table.proposedAt} IS NULL OR ${table.verifiedAt} IS NULL OR ${table.proposedAt} >= ${table.verifiedAt}`,
    ),
    check(
      "prospection_dossiers_chronology_sent",
      sql`${table.sentAt} IS NULL OR ${table.proposedAt} IS NULL OR ${table.sentAt} >= ${table.proposedAt}`,
    ),
    check(
      "prospection_dossiers_chronology_followed_up",
      sql`${table.followedUpAt} IS NULL OR ${table.sentAt} IS NULL OR ${table.followedUpAt} >= ${table.sentAt}`,
    ),
    check(
      "prospection_dossiers_chronology_closed",
      sql`${table.closedAt} IS NULL OR ${table.closedAt} >= ${table.openedAt}`,
    ),

    check("prospection_dossiers_revision_positive", sql`${table.revision} >= 0`),
  ],
);

/* -------------------------------------------------------------------------- */
/* 4. File proposée — distincte de l'outbox d'expédition                       */
/* -------------------------------------------------------------------------- */

/**
 * Messages validés par une personne, prêts à être copiés et expédiés à la main.
 *
 * Ce n'est PAS l'outbox transactionnel d'expédition. Deux protections
 * distinctes, qu'il faut ne pas confondre :
 *   · structurelle — la contrainte delivery_allowed = false empêche
 *     l'activation accidentelle du champ par une simple mise à jour ;
 *   · architecturale — aucune règle SQL n'empêche un programme de lire subject
 *     et body pour les envoyer. Cette garantie repose sur l'interdiction, au
 *     niveau du projet, de brancher un worker d'expédition sur cette table.
 *
 * onDelete: "restrict" : supprimer un dossier ne doit pas effacer la preuve
 * qu'un message a été validé et proposé. La suppression d'un dossier suppose
 * donc de traiter explicitement ses propositions au préalable — c'est une
 * décision de rétention, pas un effet de bord.
 */
export const prospectionProposals = pgTable(
  "prospection_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dossierId: uuid("dossier_id")
      .notNull()
      .references(() => prospectionDossiers.id, { onDelete: "restrict" }),

    kind: text("kind").notNull().default("first_contact"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),

    /**
     * Empreinte HMAC du destinataire au moment de la validation.
     *
     * Fige la proposition sur la personne pour laquelle son contenu a été relu.
     * Si l'adresse du dossier change, l'empreinte ne correspond plus et le
     * service doit retirer la proposition et exiger une nouvelle validation
     * humaine.
     */
    recipientHmac: text("recipient_hmac").notNull(),

    /**
     * Acteur humain ayant validé, au format `admin:<uuid>`.
     *
     * Le format est imposé par contrainte : une chaîne comme « scheduler » ou
     * « automation » est refusée par la base. La valeur doit provenir de
     * l'authentification serveur et ne jamais être acceptée depuis le corps de
     * la requête.
     */
    validatedByActor: text("validated_by_actor").notNull(),
    validatedAt: timestamp("validated_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),

    deliveryAllowed: boolean("delivery_allowed").notNull().default(false),
  },
  (table) => [
    uniqueIndex("prospection_proposals_active_key")
      .on(table.dossierId, table.kind)
      .where(sql`${table.withdrawnAt} IS NULL`),
    index("prospection_proposals_dossier_idx").on(table.dossierId),

    check("prospection_proposals_kind_known", oneOf(table.kind, PROSPECTION_PROPOSAL_KINDS)),
    check(
      "prospection_proposals_recipient_is_hmac",
      sql`${table.recipientHmac} ~ ${HEX64}`,
    ),
    check(
      "prospection_proposals_actor_format",
      sql`${table.validatedByActor} ~ ${ADMIN_ACTOR}`,
    ),
    check(
      "prospection_proposals_delivery_disabled_lot1",
      sql`${table.deliveryAllowed} = false`,
    ),
    check(
      "prospection_proposals_withdrawn_after_validated",
      sql`${table.withdrawnAt} IS NULL OR ${table.withdrawnAt} >= ${table.validatedAt}`,
    ),
    check("prospection_proposals_subject_length", sql`length(${table.subject}) BETWEEN 10 AND 200`),
    check("prospection_proposals_body_length", sql`length(${table.body}) BETWEEN 200 AND 8000`),
  ],
);

/* -------------------------------------------------------------------------- */
/* 5. Opposition — irréversible                                               */
/* -------------------------------------------------------------------------- */

/**
 * Aucune colonne de retrait, aucune date de lever : une opposition enregistrée
 * ne se défait pas depuis le code applicatif.
 *
 * L'empreinte est un HMAC-SHA-256 calculé avec un secret serveur dédié, et non
 * un SHA-256 nu : une empreinte simple d'adresse courante se retrouve par
 * dictionnaire précalculé. Le résultat reste une pseudonymisation, pas une
 * anonymisation, mais il résiste à l'énumération hors ligne.
 *
 * Le secret ne doit jamais être stocké en base, ni figurer dans le journal.
 */
export const prospectionOppositions = pgTable(
  "prospection_oppositions",
  {
    emailHmac: text("email_hmac").primaryKey(),
    origin: text("origin").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("prospection_oppositions_is_hmac", sql`${table.emailHmac} ~ ${HEX64}`),
    check(
      "prospection_oppositions_origin_known",
      oneOf(table.origin, PROSPECTION_OPPOSITION_ORIGINS),
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 6. Journal caviardé                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Aucune colonne de texte libre : des vocabulaires fermés, un slug au format
 * strictement contraint, et un entier de mesure.
 *
 * Le format du slug interdit le caractère « @ » et l'espace : un appel mal
 * formé ne peut donc pas y inscrire une adresse ou un message. Le service doit
 * de plus n'y recopier que le slug du dossier, jamais une valeur venue d'une
 * requête cliente.
 *
 * Append-only par convention transactionnelle. UPDATE et DELETE restent
 * techniquement possibles : à verrouiller par les permissions du rôle
 * applicatif, ou par un trigger, si l'immuabilité doit être garantie.
 */
export const prospectionJournal = pgTable(
  "prospection_journal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dossierId: uuid("dossier_id").references(() => prospectionDossiers.id, {
      onDelete: "set null",
    }),
    slug: text("slug"),

    event: text("event").notNull(),
    stateBefore: text("state_before"),
    stateAfter: text("state_after"),
    reason: text("reason"),

    /** Un nombre, jamais une chaîne : nombre d'indices, compteur, durée. */
    measure: integer("measure"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("prospection_journal_dossier_idx").on(table.dossierId),
    index("prospection_journal_occurred_idx").on(table.occurredAt),

    check("prospection_journal_event_known", oneOf(table.event, PROSPECTION_EVENTS)),
    check(
      "prospection_journal_state_before_known",
      nullOrOneOf(table.stateBefore, PROSPECTION_STATES),
    ),
    check(
      "prospection_journal_state_after_known",
      nullOrOneOf(table.stateAfter, PROSPECTION_STATES),
    ),
    check("prospection_journal_reason_known", nullOrOneOf(table.reason, PROSPECTION_REASONS)),
    check(
      "prospection_journal_slug_format",
      sql`${table.slug} IS NULL OR ${table.slug} ~ ${SLUG}`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 7. Types                                                                   */
/* -------------------------------------------------------------------------- */

export type ProspectionDossier = typeof prospectionDossiers.$inferSelect;
export type NewProspectionDossier = typeof prospectionDossiers.$inferInsert;
export type ProspectionProposal = typeof prospectionProposals.$inferSelect;
export type NewProspectionProposal = typeof prospectionProposals.$inferInsert;
export type ProspectionOpposition = typeof prospectionOppositions.$inferSelect;
export type ProspectionJournalEntry = typeof prospectionJournal.$inferSelect;

/* -------------------------------------------------------------------------- */
/* 8. Règles applicatives — à faire respecter par le service du lot 1B         */
/* -------------------------------------------------------------------------- */

/**
 * Transitions autorisées.
 *
 * ⚠️ Règle APPLICATIVE, et non contrainte de base. PostgreSQL ignore cette
 * structure : un `UPDATE ... SET state = 'enrolled'` direct réussirait. Elle
 * n'a de valeur que si toutes les mutations passent par le service
 * transactionnel, avec une mise à jour conditionnée par (id, state, revision),
 * et si aucun autre composant ne détient de droit d'écriture sur la table.
 */
export const PROSPECTION_TRANSITIONS: Readonly<
  Record<ProspectionState, readonly ProspectionState[]>
> = {
  opened: ["verified", "inconsistent", "no_website", "opposed", "abandoned"],
  verified: ["draft_ready", "inconsistent", "opposed", "abandoned"],
  draft_ready: ["proposed", "verified", "opposed", "abandoned"],
  proposed: ["sent", "draft_ready", "opposed", "abandoned"],
  sent: ["followed_up", "replied", "declined", "no_reply", "opposed"],
  followed_up: ["replied", "declined", "no_reply", "opposed"],
  replied: ["enrolled", "declined", "opposed"],
  inconsistent: ["opened", "abandoned"],
  no_website: ["opened", "abandoned"],
  enrolled: [],
  declined: [],
  no_reply: [],
  opposed: [],
  abandoned: [],
} as const;

export const PROSPECTION_TERMINAL_STATES: readonly ProspectionState[] = TERMINAL;

/** Délais métier. Calculés au lot 1, appliqués au lot 3. */
export const PROSPECTION_FOLLOW_UP_AFTER_DAYS = 8;
export const PROSPECTION_CLOSE_AFTER_DAYS = 21;
export const PROSPECTION_MAX_FOLLOW_UPS = 1;
export const PROSPECTION_MIN_SIGNALS = 2;

export function isProspectionTransitionAllowed(
  from: ProspectionState,
  to: ProspectionState,
): boolean {
  return PROSPECTION_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Contraintes critiques à déclarer dans expectedNonSn13Constraints, afin que le
 * contrôle de dérive existant les vérifie. La liste est exportée ici pour
 * qu'elle reste solidaire du schéma qu'elle protège.
 */
export const PROSPECTION_CRITICAL_CONSTRAINTS = [
  "prospection_dossiers_state_known",
  "prospection_dossiers_follow_up_capped",
  "prospection_dossiers_followed_up_is_consistent",
  "prospection_dossiers_hook_required",
  "prospection_dossiers_contact_required",
  "prospection_dossiers_slug_format",
  "prospection_proposals_kind_known",
  "prospection_proposals_recipient_is_hmac",
  "prospection_proposals_actor_format",
  "prospection_proposals_delivery_disabled_lot1",
  "prospection_oppositions_is_hmac",
  "prospection_oppositions_origin_known",
  "prospection_journal_event_known",
  "prospection_journal_slug_format",
] as const;
