/**
 * Novaluth — Prospection des ateliers · LOT 1A : schéma seul
 * ==========================================================
 *
 * Emplacement : lib/db/src/schema/novaluth-prospection.ts
 * Réexport    : export * from "./novaluth-prospection";  dans schema/index.ts
 *
 * VERSION 4 — après trois revues techniques.
 *
 * Corrections depuis la v3 :
 *   1. prospection_oppositions utilise une VRAIE clé primaire composite via
 *      primaryKey(), et non un uniqueIndex nommé « pkey ». Un index unique
 *      n'est pas une contrainte PRIMARY KEY : l'introspection, les outils de
 *      migration et la sémantique du modèle s'en trouvaient faussés.
 *   2. PROSPECTION_CRITICAL_CONSTRAINTS contient du SQL COMPLET, sans aucun
 *      placeholder. Les listes de valeurs y sont écrites en entier.
 *   3. Contrainte proposed_at >= hook_validated_at ajoutée : une proposition ne
 *      peut pas précéder la validation humaine de l'accroche qu'elle contient.
 *   4. Les listes de valeurs et les expressions régulières des contraintes sont
 *      construites avec sql.raw et non par interpolation paramétrée. Voir la
 *      note « littéraux SQL » ci-dessous : c'est ce qui garantit qu'aucun
 *      paramètre $1 ne subsiste dans le CREATE TABLE généré.
 *
 * PÉRIMÈTRE : données et invariants de ligne uniquement. Le service
 * transactionnel est le lot 1B.
 *
 * ⚠️ CE QUE CE SCHÉMA GARANTIT
 * ----------------------------
 * Sur chaque ligne, quelle que soit l'origine de l'écriture : vocabulaires
 * fermés ; compteur de relance à 0 ou 1 ; horodatages exigés par l'état, dans
 * un ordre chronologique cohérent ; destinataire figé par empreinte ; compte
 * validateur existant ; delivery_allowed impossible à mettre à vrai ;
 * empreintes au format d'empreinte ; aucun texte libre dans le journal ;
 * longueurs bornées ; aucun dossier orphelin.
 *
 * ⚠️ CE QU'IL NE GARANTIT PAS
 * ---------------------------
 *   · la légalité d'une TRANSITION — PROSPECTION_TRANSITIONS est une règle
 *     applicative. Un UPDATE direct réussirait, même si les contraintes
 *     d'horodatage le rendent difficile. La garantie repose sur le service
 *     transactionnel, seul détenteur du droit d'écriture, avec mise à jour
 *     conditionnée par (id, state, revision).
 *   · le RÔLE du compte validateur — la clé étrangère prouve qu'il existe, pas
 *     qu'il est actif ni administrateur. Le service doit vérifier
 *     « role = admin » et le caractère actif du compte, dans la transaction ou
 *     immédiatement avant l'écriture protégée.
 *   · la longueur de CHAQUE indice du tableau — PostgreSQL ne l'exprime pas
 *     simplement sans fonction auxiliaire. Le service doit imposer : au plus
 *     vingt indices, une longueur maximale par indice, aucune chaîne vide,
 *     aucun contenu brut volumineux extrait de la page.
 *   · l'immuabilité du journal — append-only par convention transactionnelle.
 *     UPDATE et DELETE restent possibles : à verrouiller par les permissions du
 *     rôle applicatif ou par un trigger.
 *   · l'absence d'envoi réel — delivery_allowed = false empêche l'activation
 *     accidentelle du champ ; l'absence d'envoi dépend AUSSI de la règle
 *     d'architecture interdisant tout worker de lecture de subject/body vers le
 *     service d'expédition.
 *   · la correspondance entre journal.slug et journal.dossierId — le slug est
 *     conservé pour survivre à la suppression du dossier. Le service doit
 *     toujours le recopier depuis le dossier chargé dans la transaction.
 *
 * ⚠️ LITTÉRAUX SQL — POURQUOI sql.raw ET NON sql`${valeur}`
 * ---------------------------------------------------------
 * Dans le SQL dynamique, `sql`${valeur}`` produit un paramètre lié. Dans une
 * contrainte CHECK, l'expression est écrite une fois pour toutes dans la DDL :
 * un paramètre y serait sans objet, et un $1 résiduel dans le CREATE TABLE
 * ferait échouer la migration ou créerait une contrainte inerte.
 *
 * Les listes de valeurs et les expressions régulières sont donc sérialisées en
 * littéraux SQL par les fabriques ci-dessous, protégées par un garde-fou : toute
 * valeur ne correspondant pas à ^[a-z][a-z0-9_]*$, et tout texte contenant une
 * apostrophe, provoque une erreur au chargement du module plutôt qu'une
 * injection silencieuse.
 */

import { sql, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ⚠️ CHEMINS À CONFIRMER : ajuster si ces tables sont exportées ailleurs.
import { novaluthProfilesTable } from "./novaluth";
import { novaluthPlatformAccountsTable } from "./novaluth-identity";

/* -------------------------------------------------------------------------- */
/* 1. Vocabulaires fermés — source de vérité unique                           */
/* -------------------------------------------------------------------------- */

export const PROSPECTION_STATES = [
  "opened",
  "verified",
  "draft_ready",
  "proposed",
  "sent",
  "followed_up",
  "replied",
  "enrolled",
  "declined",
  "no_reply",
  "inconsistent",
  "no_website",
  "opposed",
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

/** Origine de PRODUCTION de l'accroche. Indépendante de sa validation. */
export const PROSPECTION_HOOK_ORIGINS = ["signals", "human", "ai"] as const;

export const PROSPECTION_PROPOSAL_KINDS = ["first_contact", "follow_up"] as const;

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
/* 2. Groupes d'états                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `opposed` et `abandoned` sont volontairement exclus de tous les groupes
 * ci-dessous : ils sont atteignables à tout moment, avant comme après l'envoi.
 */
const POST_VERIFY_STATES = [
  "verified",
  "draft_ready",
  "proposed",
  "sent",
  "followed_up",
  "replied",
  "enrolled",
  "declined",
  "no_reply",
] as const satisfies readonly ProspectionState[];

const POST_DRAFT_STATES = [
  "draft_ready",
  "proposed",
  "sent",
  "followed_up",
  "replied",
  "enrolled",
  "declined",
  "no_reply",
] as const satisfies readonly ProspectionState[];

const POST_PROPOSAL_STATES = [
  "proposed",
  "sent",
  "followed_up",
  "replied",
  "enrolled",
  "declined",
  "no_reply",
] as const satisfies readonly ProspectionState[];

const POST_SEND_STATES = [
  "sent",
  "followed_up",
  "replied",
  "enrolled",
  "declined",
  "no_reply",
] as const satisfies readonly ProspectionState[];

const PRE_FOLLOW_UP_STATES = [
  "opened",
  "verified",
  "draft_ready",
  "proposed",
  "sent",
  "inconsistent",
  "no_website",
] as const satisfies readonly ProspectionState[];

const LIVE_STATES = [
  "opened",
  "verified",
  "draft_ready",
  "proposed",
  "sent",
  "followed_up",
  "replied",
  "inconsistent",
  "no_website",
] as const satisfies readonly ProspectionState[];

const TERMINAL_STATES = [
  "enrolled",
  "declined",
  "no_reply",
  "opposed",
  "abandoned",
] as const satisfies readonly ProspectionState[];

/* -------------------------------------------------------------------------- */
/* 3. Fabriques de littéraux SQL                                              */
/* -------------------------------------------------------------------------- */

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/**
 * Sérialise une liste de valeurs en littéraux SQL : `'a', 'b', 'c'`.
 *
 * Refuse toute valeur qui n'est pas un identifiant en minuscules. Les
 * vocabulaires de ce module respectent tous cette forme ; une valeur exotique
 * ajoutée par erreur provoque une exception au chargement du module, jamais une
 * contrainte silencieusement fausse.
 */
function literalList(values: readonly string[]): SQL {
  for (const value of values) {
    if (!IDENTIFIER.test(value)) {
      throw new Error(
        `[novaluth-prospection] valeur de vocabulaire invalide : « ${value} ». ` +
          "Seuls les identifiants ^[a-z][a-z0-9_]*$ sont acceptés dans une contrainte CHECK.",
      );
    }
  }
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

/** Sérialise un motif d'expression régulière en littéral SQL. */
function literalPattern(pattern: string): SQL {
  if (pattern.includes("'")) {
    throw new Error(
      "[novaluth-prospection] un motif contenant une apostrophe ne peut pas être " +
        "sérialisé sans échappement explicite.",
    );
  }
  return sql.raw(`'${pattern}'`);
}

/** Sérialise un entier en littéral SQL. */
function literalInt(value: number): SQL {
  if (!Number.isInteger(value)) {
    throw new Error("[novaluth-prospection] entier attendu.");
  }
  return sql.raw(String(value));
}

/** `colonne IN ('a', 'b', …)` — littéraux, jamais de paramètres. */
function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${literalList(values)})`;
}

function nullOrOneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IS NULL OR ${oneOf(column, values)}`;
}

/** Implication : si l'état appartient à `states`, alors `then` doit être vrai. */
function whenState(
  column: AnyPgColumn,
  states: readonly ProspectionState[],
  then: SQL,
): SQL {
  return sql`NOT (${oneOf(column, states)}) OR (${then})`;
}

/** Longueur du texte utile : refuse une chaîne composée uniquement d'espaces. */
function trimmedLength(column: AnyPgColumn, min: number, max: number): SQL {
  return sql`length(btrim(${column})) BETWEEN ${literalInt(min)} AND ${literalInt(max)}`;
}

function nullOrTrimmedLength(column: AnyPgColumn, min: number, max: number): SQL {
  return sql`${column} IS NULL OR ${trimmedLength(column, min, max)}`;
}

function matches(column: AnyPgColumn, pattern: string): SQL {
  return sql`${column} ~ ${literalPattern(pattern)}`;
}

/** Empreinte HMAC-SHA-256 en hexadécimal minuscule. */
const HEX64 = "^[0-9a-f]{64}$";

/** Slug d'annuaire : minuscules, chiffres, tirets. Interdit « @ » et l'espace. */
const SLUG = "^[a-z0-9]([a-z0-9-]{0,118}[a-z0-9])?$";

const MAX_SIGNALS = 20;

/* -------------------------------------------------------------------------- */
/* 4. Convention d'empreinte — À NE PLUS JAMAIS MODIFIER                      */
/* -------------------------------------------------------------------------- */

/**
 * Procédure de calcul de l'empreinte d'une adresse, figée pour la version 1 :
 *
 *   1. retirer les espaces extérieurs ;
 *   2. passer l'adresse en minuscules ;
 *   3. valider sa syntaxe — une adresse invalide est refusée, pas hachée ;
 *   4. encoder en UTF-8 ;
 *   5. appliquer HMAC-SHA-256 avec le secret serveur dédié à la prospection ;
 *   6. produire l'hexadécimal minuscule.
 *
 * Cette convention ne doit plus changer : les oppositions historiques ne
 * seraient plus retrouvées.
 *
 * ROTATION DU SECRET — le service devra gérer un trousseau, par exemple :
 *
 *     version 1 → ancien secret
 *     version 2 → secret courant
 *
 * Une adresse candidate est recalculée pour CHAQUE version active et comparée
 * aux oppositions de la version correspondante. Les secrets ne sont jamais
 * stockés en base, ni inscrits dans le journal.
 */
export const PROSPECTION_HMAC_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* 5. Dossier de prospection                                                  */
/* -------------------------------------------------------------------------- */

export const prospectionDossiers = pgTable(
  "prospection_dossiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Fiche de l'annuaire. Clé étrangère réelle : aucun dossier orphelin. */
    slug: text("slug")
      .notNull()
      .references(() => novaluthProfilesTable.slug, { onDelete: "restrict" }),

    workshopName: text("workshop_name").notNull(),
    websiteUrl: text("website_url"),

    /**
     * Adresse professionnelle publique relevée sur le site de l'atelier.
     * L'opposition se contrôle par comparaison d'empreintes calculées par le
     * service, jamais par jointure SQL.
     */
    contactEmail: text("contact_email"),
    contactFirstName: text("contact_first_name"),

    state: text("state").notNull().default("opened"),
    lastReason: text("last_reason"),

    hook: text("hook"),

    /** Origine de PRODUCTION. Ne change pas lors de la relecture humaine. */
    hookOrigin: text("hook_origin"),

    /** Date de validation humaine. Indépendante de l'origine de production. */
    hookValidatedAt: timestamp("hook_validated_at", { withTimezone: true }),

    /** Compte ayant validé l'accroche. Le rôle reste vérifié par le service. */
    hookValidatedByAccountId: integer("hook_validated_by_account_id").references(
      () => novaluthPlatformAccountsTable.id,
      { onDelete: "restrict" },
    ),

    /**
     * Indices de cohérence retrouvés sur la page. Faits publics.
     * Le nombre s'obtient par cardinality() : aucun compteur redondant.
     * La longueur de chaque élément est imposée par le service, pas ici.
     */
    verifiedSignals: text("verified_signals")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

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
    check("prospection_dossiers_slug_format", matches(table.slug, SLUG)),

    /* --- longueurs, chaînes non vides ------------------------------------ */
    check(
      "prospection_dossiers_workshop_name_length",
      trimmedLength(table.workshopName, 1, 200),
    ),
    check(
      "prospection_dossiers_website_url_length",
      nullOrTrimmedLength(table.websiteUrl, 8, 2048),
    ),
    check(
      "prospection_dossiers_contact_email_length",
      nullOrTrimmedLength(table.contactEmail, 6, 320),
    ),
    check(
      "prospection_dossiers_contact_first_name_length",
      nullOrTrimmedLength(table.contactFirstName, 1, 100),
    ),
    check("prospection_dossiers_hook_length", nullOrTrimmedLength(table.hook, 40, 2000)),
    check(
      "prospection_dossiers_signals_capped",
      sql`cardinality(${table.verifiedSignals}) <= ${literalInt(MAX_SIGNALS)}`,
    ),

    /* --- relance : exactement une fois ----------------------------------- */
    check(
      "prospection_dossiers_follow_up_capped",
      sql`${table.followUpCount} BETWEEN ${literalInt(0)} AND ${literalInt(1)}`,
    ),
    check(
      "prospection_dossiers_follow_up_needs_date",
      sql`${table.followUpCount} = ${literalInt(0)} OR ${table.followedUpAt} IS NOT NULL`,
    ),
    check(
      "prospection_dossiers_follow_up_date_needs_count",
      sql`${table.followedUpAt} IS NULL OR ${table.followUpCount} = ${literalInt(1)}`,
    ),
    check(
      "prospection_dossiers_no_early_follow_up",
      whenState(
        table.state,
        PRE_FOLLOW_UP_STATES,
        sql`${table.followUpCount} = ${literalInt(0)}`,
      ),
    ),
    check(
      "prospection_dossiers_followed_up_is_consistent",
      whenState(
        table.state,
        ["followed_up"],
        sql`${table.followUpCount} = ${literalInt(1)} AND ${table.followedUpAt} IS NOT NULL`,
      ),
    ),

    /* --- accroche : produite avant verified, validée avant draft_ready ---- */
    check(
      "prospection_dossiers_hook_required",
      whenState(
        table.state,
        POST_VERIFY_STATES,
        sql`${table.hook} IS NOT NULL AND ${table.hookOrigin} IS NOT NULL`,
      ),
    ),
    check(
      "prospection_dossiers_hook_validation_required",
      whenState(
        table.state,
        POST_DRAFT_STATES,
        sql`${table.hookValidatedAt} IS NOT NULL AND ${table.hookValidatedByAccountId} IS NOT NULL`,
      ),
    ),
    check(
      "prospection_dossiers_hook_validation_is_complete",
      sql`(${table.hookValidatedAt} IS NULL) = (${table.hookValidatedByAccountId} IS NULL)`,
    ),

    /* --- adresse de contact ---------------------------------------------- */
    check(
      "prospection_dossiers_contact_required",
      whenState(table.state, POST_PROPOSAL_STATES, sql`${table.contactEmail} IS NOT NULL`),
    ),

    /* --- horodatages exigés par l'état ----------------------------------- */
    check(
      "prospection_dossiers_verified_at_required",
      whenState(table.state, POST_VERIFY_STATES, sql`${table.verifiedAt} IS NOT NULL`),
    ),
    check(
      "prospection_dossiers_proposed_at_required",
      whenState(table.state, POST_PROPOSAL_STATES, sql`${table.proposedAt} IS NOT NULL`),
    ),
    check(
      "prospection_dossiers_sent_at_required",
      whenState(table.state, POST_SEND_STATES, sql`${table.sentAt} IS NOT NULL`),
    ),
    check(
      "prospection_dossiers_replied_at_required",
      whenState(table.state, ["replied", "enrolled"], sql`${table.repliedAt} IS NOT NULL`),
    ),
    check(
      "prospection_dossiers_closed_at_required",
      whenState(table.state, TERMINAL_STATES, sql`${table.closedAt} IS NOT NULL`),
    ),
    check(
      "prospection_dossiers_live_has_no_closed_at",
      whenState(table.state, LIVE_STATES, sql`${table.closedAt} IS NULL`),
    ),

    /* --- chronologie ------------------------------------------------------ */
    check(
      "prospection_dossiers_chronology_verified",
      sql`${table.verifiedAt} IS NULL OR ${table.verifiedAt} >= ${table.openedAt}`,
    ),
    check(
      "prospection_dossiers_chronology_hook_validated",
      sql`${table.hookValidatedAt} IS NULL OR ${table.verifiedAt} IS NULL OR ${table.hookValidatedAt} >= ${table.verifiedAt}`,
    ),
    check(
      "prospection_dossiers_chronology_proposed",
      sql`${table.proposedAt} IS NULL OR ${table.verifiedAt} IS NULL OR ${table.proposedAt} >= ${table.verifiedAt}`,
    ),
    // Une proposition ne précède pas la validation de l'accroche qu'elle contient.
    check(
      "prospection_dossiers_chronology_proposed_after_validation",
      sql`${table.proposedAt} IS NULL OR ${table.hookValidatedAt} IS NULL OR ${table.proposedAt} >= ${table.hookValidatedAt}`,
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
      "prospection_dossiers_chronology_replied",
      sql`${table.repliedAt} IS NULL OR ${table.sentAt} IS NULL OR ${table.repliedAt} >= ${table.sentAt}`,
    ),
    check(
      "prospection_dossiers_chronology_closed",
      sql`${table.closedAt} IS NULL OR ${table.closedAt} >= ${table.openedAt}`,
    ),
    check(
      "prospection_dossiers_chronology_closed_after_send",
      whenState(
        table.state,
        POST_SEND_STATES,
        sql`${table.closedAt} IS NULL OR ${table.sentAt} IS NULL OR ${table.closedAt} >= ${table.sentAt}`,
      ),
    ),

    check(
      "prospection_dossiers_revision_positive",
      sql`${table.revision} >= ${literalInt(0)}`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 6. File proposée — distincte de l'outbox d'expédition                       */
/* -------------------------------------------------------------------------- */

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
     * Empreinte du destinataire au moment de la validation. Fige la proposition
     * sur la personne pour laquelle le contenu a été relu : si l'adresse du
     * dossier change, le service doit retirer la proposition et exiger une
     * nouvelle validation humaine.
     */
    recipientHmac: text("recipient_hmac").notNull(),
    recipientHmacVersion: integer("recipient_hmac_version")
      .notNull()
      .default(PROSPECTION_HMAC_VERSION),

    /**
     * Compte ayant validé. La clé étrangère prouve son existence, pas son rôle
     * ni son caractère actif : le service doit vérifier « role = admin » dans la
     * transaction, et ne jamais accepter cette valeur depuis le corps de la
     * requête.
     */
    validatedByAccountId: integer("validated_by_account_id")
      .notNull()
      .references(() => novaluthPlatformAccountsTable.id, { onDelete: "restrict" }),

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
    check("prospection_proposals_recipient_is_hmac", matches(table.recipientHmac, HEX64)),
    check(
      "prospection_proposals_hmac_version_positive",
      sql`${table.recipientHmacVersion} >= ${literalInt(1)}`,
    ),
    check(
      "prospection_proposals_delivery_disabled_lot1",
      sql`${table.deliveryAllowed} = false`,
    ),
    check("prospection_proposals_subject_length", trimmedLength(table.subject, 10, 200)),
    check("prospection_proposals_body_length", trimmedLength(table.body, 200, 8000)),
    check(
      "prospection_proposals_withdrawn_after_validated",
      sql`${table.withdrawnAt} IS NULL OR ${table.withdrawnAt} >= ${table.validatedAt}`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 7. Opposition — irréversible, vraie clé primaire composite                 */
/* -------------------------------------------------------------------------- */

/**
 * Aucune colonne de retrait, aucune date de lever : une opposition enregistrée
 * ne se défait pas depuis le code applicatif.
 *
 * L'empreinte est un HMAC-SHA-256 calculé avec un secret serveur dédié, selon la
 * convention figée plus haut. Pseudonymisation assumée, pas anonymisation, mais
 * résistante à l'énumération hors ligne — ce qu'un SHA-256 nu n'est pas.
 *
 * La clé primaire porte réellement sur le couple (empreinte, version) : une
 * rotation du secret n'efface pas les oppositions historiques.
 */
export const prospectionOppositions = pgTable(
  "prospection_oppositions",
  {
    emailHmac: text("email_hmac").notNull(),
    hmacVersion: integer("hmac_version").notNull().default(PROSPECTION_HMAC_VERSION),
    origin: text("origin").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "prospection_oppositions_pkey",
      columns: [table.emailHmac, table.hmacVersion],
    }),
    index("prospection_oppositions_version_idx").on(table.hmacVersion),

    check("prospection_oppositions_is_hmac", matches(table.emailHmac, HEX64)),
    check(
      "prospection_oppositions_version_positive",
      sql`${table.hmacVersion} >= ${literalInt(1)}`,
    ),
    check(
      "prospection_oppositions_origin_known",
      oneOf(table.origin, PROSPECTION_OPPOSITION_ORIGINS),
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 8. Journal caviardé                                                        */
/* -------------------------------------------------------------------------- */

export const prospectionJournal = pgTable(
  "prospection_journal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dossierId: uuid("dossier_id").references(() => prospectionDossiers.id, {
      onDelete: "set null",
    }),
    /** Conservé pour survivre à la suppression du dossier. */
    slug: text("slug"),

    event: text("event").notNull(),
    stateBefore: text("state_before"),
    stateAfter: text("state_after"),
    reason: text("reason"),

    /** Compteur, durée ou nombre d'indices. Jamais négatif, jamais une chaîne. */
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
      sql`${table.slug} IS NULL OR ${table.slug} ~ ${literalPattern(SLUG)}`,
    ),
    check(
      "prospection_journal_measure_positive",
      sql`${table.measure} IS NULL OR ${table.measure} >= ${literalInt(0)}`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* 9. Types                                                                   */
/* -------------------------------------------------------------------------- */

export type ProspectionDossier = typeof prospectionDossiers.$inferSelect;
export type NewProspectionDossier = typeof prospectionDossiers.$inferInsert;
export type ProspectionProposal = typeof prospectionProposals.$inferSelect;
export type NewProspectionProposal = typeof prospectionProposals.$inferInsert;
export type ProspectionOpposition = typeof prospectionOppositions.$inferSelect;
export type ProspectionJournalEntry = typeof prospectionJournal.$inferSelect;

/* -------------------------------------------------------------------------- */
/* 10. Règles applicatives — à faire respecter par le service du lot 1B        */
/* -------------------------------------------------------------------------- */

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

export const PROSPECTION_TERMINAL_STATES: readonly ProspectionState[] = TERMINAL_STATES;

export const PROSPECTION_FOLLOW_UP_AFTER_DAYS = 8;
export const PROSPECTION_CLOSE_AFTER_DAYS = 21;
export const PROSPECTION_MAX_FOLLOW_UPS = 1;
export const PROSPECTION_MIN_SIGNALS = 2;
export const PROSPECTION_MAX_SIGNALS = MAX_SIGNALS;

/** Longueur maximale d'un indice. Imposée par le service, pas par la base. */
export const PROSPECTION_MAX_SIGNAL_LENGTH = 200;

export function isProspectionTransitionAllowed(
  from: ProspectionState,
  to: ProspectionState,
): boolean {
  return PROSPECTION_TRANSITIONS[from]?.includes(to) ?? false;
}

/* -------------------------------------------------------------------------- */
/* 11. Contraintes critiques — SQL complet, sans placeholder                  */
/* -------------------------------------------------------------------------- */

const STATES_SQL = PROSPECTION_STATES.map((s) => `'${s}'`).join(", ");
const EVENTS_SQL = PROSPECTION_EVENTS.map((e) => `'${e}'`).join(", ");
const PRE_FOLLOW_UP_SQL = PRE_FOLLOW_UP_STATES.map((s) => `'${s}'`).join(", ");
const POST_VERIFY_SQL = POST_VERIFY_STATES.map((s) => `'${s}'`).join(", ");
const POST_DRAFT_SQL = POST_DRAFT_STATES.map((s) => `'${s}'`).join(", ");
const POST_PROPOSAL_SQL = POST_PROPOSAL_STATES.map((s) => `'${s}'`).join(", ");
const POST_SEND_SQL = POST_SEND_STATES.map((s) => `'${s}'`).join(", ");
const OPPOSITION_ORIGINS_SQL = PROSPECTION_OPPOSITION_ORIGINS.map((o) => `'${o}'`).join(", ");

/**
 * À ajouter à expectedNonSn13Constraints dans lib/db/src/schema-check.ts, en
 * important cette constante plutôt qu'en recopiant les chaînes.
 *
 * Les définitions ci-dessous sont du SQL COMPLET et déterministe, construit à
 * partir des mêmes vocabulaires que les contraintes elles-mêmes : aucun
 * placeholder ne peut subsister.
 *
 * ⚠️ PostgreSQL normalise néanmoins les expressions — parenthésage, réécriture
 * de BETWEEN, qualification des colonnes. Après la première migration sur
 * PostgreSQL isolé, relevez la forme réelle et alignez ces définitions :
 *
 *   SELECT c.conname, pg_get_constraintdef(c.oid)
 *   FROM pg_constraint c
 *   JOIN pg_class t ON t.oid = c.conrelid
 *   WHERE t.relname LIKE 'prospection\_%' AND c.contype = 'c'
 *   ORDER BY t.relname, c.conname;
 *
 * Vérifiez à cette occasion qu'aucun paramètre ($1, $2, …) n'apparaît dans les
 * définitions actives : c'est le contrôle qui valide les fabriques de littéraux
 * du paragraphe 3.
 */
export const PROSPECTION_CRITICAL_CONSTRAINTS = [
  {
    tableName: "prospection_dossiers",
    name: "prospection_dossiers_state_known",
    definition: `CHECK (state IN (${STATES_SQL}))`,
  },
  {
    tableName: "prospection_dossiers",
    name: "prospection_dossiers_follow_up_capped",
    definition: "CHECK (follow_up_count BETWEEN 0 AND 1)",
  },
  {
    tableName: "prospection_dossiers",
    name: "prospection_dossiers_followed_up_is_consistent",
    definition:
      "CHECK (NOT (state IN ('followed_up')) OR (follow_up_count = 1 AND followed_up_at IS NOT NULL))",
  },
  {
    tableName: "prospection_dossiers",
    name: "prospection_dossiers_no_early_follow_up",
    definition: `CHECK (NOT (state IN (${PRE_FOLLOW_UP_SQL})) OR (follow_up_count = 0))`,
  },
  {
    tableName: "prospection_dossiers",
    name: "prospection_dossiers_hook_required",
    definition: `CHECK (NOT (state IN (${POST_VERIFY_SQL})) OR (hook IS NOT NULL AND hook_origin IS NOT NULL))`,
  },
  {
    tableName: "prospection_dossiers",
    name: "prospection_dossiers_hook_validation_required",
    definition: `CHECK (NOT (state IN (${POST_DRAFT_SQL})) OR (hook_validated_at IS NOT NULL AND hook_validated_by_account_id IS NOT NULL))`,
  },
  {
    tableName: "prospection_dossiers",
    name: "prospection_dossiers_contact_required",
    definition: `CHECK (NOT (state IN (${POST_PROPOSAL_SQL})) OR (contact_email IS NOT NULL))`,
  },
  {
    tableName: "prospection_dossiers",
    name: "prospection_dossiers_sent_at_required",
    definition: `CHECK (NOT (state IN (${POST_SEND_SQL})) OR (sent_at IS NOT NULL))`,
  },
  {
    tableName: "prospection_dossiers",
    name: "prospection_dossiers_chronology_proposed_after_validation",
    definition:
      "CHECK (proposed_at IS NULL OR hook_validated_at IS NULL OR proposed_at >= hook_validated_at)",
  },
  {
    tableName: "prospection_dossiers",
    name: "prospection_dossiers_slug_format",
    definition: `CHECK (slug ~ '${SLUG}')`,
  },
  {
    tableName: "prospection_proposals",
    name: "prospection_proposals_kind_known",
    definition: "CHECK (kind IN ('first_contact', 'follow_up'))",
  },
  {
    tableName: "prospection_proposals",
    name: "prospection_proposals_recipient_is_hmac",
    definition: `CHECK (recipient_hmac ~ '${HEX64}')`,
  },
  {
    tableName: "prospection_proposals",
    name: "prospection_proposals_delivery_disabled_lot1",
    definition: "CHECK (delivery_allowed = false)",
  },
  {
    tableName: "prospection_oppositions",
    name: "prospection_oppositions_is_hmac",
    definition: `CHECK (email_hmac ~ '${HEX64}')`,
  },
  {
    tableName: "prospection_oppositions",
    name: "prospection_oppositions_origin_known",
    definition: `CHECK (origin IN (${OPPOSITION_ORIGINS_SQL}))`,
  },
  {
    tableName: "prospection_journal",
    name: "prospection_journal_event_known",
    definition: `CHECK (event IN (${EVENTS_SQL}))`,
  },
  {
    tableName: "prospection_journal",
    name: "prospection_journal_slug_format",
    definition: `CHECK (slug IS NULL OR slug ~ '${SLUG}')`,
  },
  {
    tableName: "prospection_journal",
    name: "prospection_journal_measure_positive",
    definition: "CHECK (measure IS NULL OR measure >= 0)",
  },
] as const;
