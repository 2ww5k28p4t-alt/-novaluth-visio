/**
 * Novaluth — Prospection des ateliers, LOT 1 : schéma
 * ===================================================
 *
 * Emplacement : lib/db/src/schema/novaluth-prospection.ts
 * À réexporter depuis lib/db/src/schema/index.ts :
 *
 *     export * from "./novaluth-prospection";
 *
 * Aucune dépendance nouvelle : drizzle-orm uniquement, déjà au catalogue
 * (^0.45.2). Volontairement sans drizzle-zod, pour ne pas déclencher le
 * garde-fou minimumReleaseAge du workspace.
 *
 * Trois principes portés par le schéma lui-même, et non par le code applicatif
 * ---------------------------------------------------------------------------
 *
 *  1. La file proposée (prospection_proposals) est une table DISTINCTE de
 *     l'outbox transactionnel d'envoi. Le lot 1 n'écrit jamais dans l'outbox :
 *     aucun envoi réel n'est possible tant qu'il n'a pas été explicitement
 *     décidé. La contrainte prospection_delivery_disabled_lot1 le garantit.
 *
 *  2. L'opposition est irréversible par construction : la table n'a ni colonne
 *     de retrait, ni horodatage de lever. L'adresse n'y figure jamais en clair,
 *     seulement son empreinte SHA-256 minuscule.
 *
 *  3. Le journal ne peut recevoir que des valeurs d'énumérations et un entier.
 *     Aucune colonne de texte libre n'existe : un texte de courriel, une
 *     adresse ou un secret sont donc refusés par la base, pas seulement par une
 *     convention de code.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------- */
/* 1. Énumérations                                                            */
/* -------------------------------------------------------------------------- */

/**
 * États du dossier de prospection. Un état absent d'ici n'existe pas :
 * PostgreSQL refuse la valeur, ce qui rend impossible l'apparition d'un état
 * inventé par une migration ou un correctif hâtif.
 */
export const prospectionStateEnum = pgEnum("prospection_state", [
  "opened", // dossier ouvert, page pas encore lue
  "verified", // cohérence validée, accroche à relire
  "draft_ready", // accroche relue et validée par un humain
  "proposed", // message validé, en file proposée
  "sent", // premier contact envoyé, marqué à la main au lot 1
  "followed_up", // relancé — au plus une fois
  "replied",
  "enrolled",
  "declined",
  "no_reply",
  "inconsistent", // cohérence refusée, fiche à corriger
  "no_website",
  "opposed", // terminal et irréversible
  "abandoned",
]);

/** Motifs journalisables. Liste fermée, volontairement. */
export const prospectionReasonEnum = pgEnum("prospection_reason", [
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
]);

/** Événements journalisables. Liste fermée également. */
export const prospectionEventEnum = pgEnum("prospection_event", [
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
]);

/**
 * Origine de l'accroche. La valeur « ai » est déclarée dès maintenant afin que
 * le lot 2 n'exige aucune migration d'énumération.
 */
export const prospectionHookOriginEnum = pgEnum("prospection_hook_origin", [
  "signals", // construite mécaniquement depuis les indices vérifiés
  "human", // rédigée ou relue par une personne
  "ai", // réservé au lot 2, inutilisé au lot 1
]);

/* -------------------------------------------------------------------------- */
/* 2. Dossier de prospection                                                  */
/* -------------------------------------------------------------------------- */

export const prospectionDossiers = pgTable(
  "prospection_dossiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Référence la fiche de l'annuaire. */
    slug: text("slug").notNull(),

    workshopName: text("workshop_name").notNull(),
    websiteUrl: text("website_url"),

    /** Adresse professionnelle publique, relevée sur le site de l'atelier. */
    contactEmail: text("contact_email"),
    contactFirstName: text("contact_first_name"),

    state: prospectionStateEnum("state").notNull().default("opened"),
    lastReason: prospectionReasonEnum("last_reason"),

    hook: text("hook"),
    hookOrigin: prospectionHookOriginEnum("hook_origin"),

    /** Indices retrouvés sur la page. Faits publics, donc conservés en clair. */
    verifiedSignals: text("verified_signals")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    signalCount: integer("signal_count").notNull().default(0),

    /** Borné à 1 par contrainte : « relance exactement une fois ». */
    followUpCount: integer("follow_up_count").notNull().default(0),

    /** Jeton de verrouillage optimiste, incrémenté à chaque transition. */
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

    // « Relance exactement une fois » : la base refuse un second incrément.
    check(
      "prospection_follow_up_capped",
      sql`${table.followUpCount} BETWEEN 0 AND 1`,
    ),

    // Un dossier vérifié possède nécessairement une accroche et son origine.
    check(
      "prospection_verified_requires_hook",
      sql`${table.state} <> 'verified' OR (${table.hook} IS NOT NULL AND ${table.hookOrigin} IS NOT NULL)`,
    ),

    // Un dossier proposé, envoyé ou relancé possède nécessairement une adresse.
    check(
      "prospection_contact_required_when_proposed",
      sql`${table.state} NOT IN ('proposed', 'sent', 'followed_up') OR ${table.contactEmail} IS NOT NULL`,
    ),

    check("prospection_signal_count_positive", sql`${table.signalCount} >= 0`),
  ],
);

/* -------------------------------------------------------------------------- */
/* 3. File proposée — distincte de l'outbox d'envoi                           */
/* -------------------------------------------------------------------------- */

/**
 * Messages validés par une personne, prêts à être copiés et expédiés à la main.
 *
 * Ce n'est PAS l'outbox transactionnel : aucun worker ne lit cette table pour
 * envoyer quoi que ce soit. Le jour où un envoi réel sera décidé, il faudra
 * créer explicitement le pont vers l'outbox et retirer la contrainte
 * prospection_delivery_disabled_lot1 — une migration consciente, pas un
 * réglage.
 */
export const prospectionProposals = pgTable(
  "prospection_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dossierId: uuid("dossier_id")
      .notNull()
      .references(() => prospectionDossiers.id, { onDelete: "cascade" }),

    kind: text("kind").notNull().default("first_contact"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),

    /** Identité humaine qui a validé. Jamais « system », « cron » ni « job ». */
    validatedBy: text("validated_by").notNull(),
    validatedAt: timestamp("validated_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),

    /** Sécurité explicite : le lot 1 n'autorise aucun envoi réel. */
    deliveryAllowed: boolean("delivery_allowed").notNull().default(false),
  },
  (table) => [
    // Une seule proposition active par dossier et par type de message.
    uniqueIndex("prospection_proposals_active_key")
      .on(table.dossierId, table.kind)
      .where(sql`${table.withdrawnAt} IS NULL`),
    index("prospection_proposals_dossier_idx").on(table.dossierId),

    check(
      "prospection_validated_by_is_human",
      sql`length(btrim(${table.validatedBy})) >= 2 AND lower(btrim(${table.validatedBy})) NOT IN ('system', 'systeme', 'cron', 'job', 'worker', 'bot')`,
    ),

    check(
      "prospection_delivery_disabled_lot1",
      sql`${table.deliveryAllowed} = false`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 4. Opposition — irréversible                                               */
/* -------------------------------------------------------------------------- */

/**
 * Aucune colonne de retrait, aucune date de lever : une opposition enregistrée
 * ne peut pas être défaite par le code applicatif. C'est le comportement voulu.
 */
export const prospectionOppositions = pgTable(
  "prospection_oppositions",
  {
    emailHash: text("email_hash").primaryKey(),
    origin: text("origin").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 64 caractères hexadécimaux : une empreinte, jamais une adresse.
    check(
      "prospection_opposition_is_hash",
      sql`${table.emailHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "prospection_opposition_origin_length",
      sql`length(${table.origin}) BETWEEN 2 AND 60`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 5. Journal caviardé                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Ni texte libre, ni adresse, ni secret : uniquement des énumérations, un slug
 * et un entier de mesure. Le caviardage est garanti par le typage de la table,
 * ce qui le rend impossible à contourner par mégarde.
 */
export const prospectionJournal = pgTable(
  "prospection_journal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dossierId: uuid("dossier_id").references(() => prospectionDossiers.id, {
      onDelete: "set null",
    }),
    slug: text("slug"),

    event: prospectionEventEnum("event").notNull(),
    stateBefore: prospectionStateEnum("state_before"),
    stateAfter: prospectionStateEnum("state_after"),
    reason: prospectionReasonEnum("reason"),

    /** Un nombre, jamais une chaîne : nombre d'indices, compteur, durée. */
    measure: integer("measure"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("prospection_journal_dossier_idx").on(table.dossierId),
    index("prospection_journal_occurred_idx").on(table.occurredAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* 6. Types                                                                   */
/* -------------------------------------------------------------------------- */

export type ProspectionState = (typeof prospectionStateEnum.enumValues)[number];
export type ProspectionReason = (typeof prospectionReasonEnum.enumValues)[number];
export type ProspectionEvent = (typeof prospectionEventEnum.enumValues)[number];
export type ProspectionHookOrigin = (typeof prospectionHookOriginEnum.enumValues)[number];

export type ProspectionDossier = typeof prospectionDossiers.$inferSelect;
export type NewProspectionDossier = typeof prospectionDossiers.$inferInsert;
export type ProspectionProposal = typeof prospectionProposals.$inferSelect;
export type NewProspectionProposal = typeof prospectionProposals.$inferInsert;
export type ProspectionOpposition = typeof prospectionOppositions.$inferSelect;
export type ProspectionJournalEntry = typeof prospectionJournal.$inferSelect;

/* -------------------------------------------------------------------------- */
/* 7. Machine à états — déclarée avec le schéma, appliquée par le service      */
/* -------------------------------------------------------------------------- */

/**
 * Transitions autorisées. Déclarée ici pour que la règle vive à côté des
 * données qu'elle protège. Le service de transitions du lot 2 l'importe et la
 * fait respecter dans une transaction unique.
 *
 * Une cible absente de l'ensemble de départ est refusée, quelle que soit
 * l'origine de l'appel : route, worker ou console.
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

export const PROSPECTION_TERMINAL_STATES: readonly ProspectionState[] = (
  Object.keys(PROSPECTION_TRANSITIONS) as ProspectionState[]
).filter((state) => PROSPECTION_TRANSITIONS[state].length === 0);

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
