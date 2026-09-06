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
import { novaluthProfilesTable } from "./novaluth";
import { novaluthPlatformAccountsTable } from "./novaluth-identity";

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
export type ProspectionProposalKind =
  (typeof PROSPECTION_PROPOSAL_KINDS)[number];
export type ProspectionOppositionOrigin =
  (typeof PROSPECTION_OPPOSITION_ORIGINS)[number];

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

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const HEX64 = "^[0-9a-f]{64}$";
const SLUG = "^[a-z0-9]([a-z0-9-]{0,118}[a-z0-9])?$";
const MAX_SIGNALS = 20;

function literalList(values: readonly string[]): SQL {
  if (values.some((value) => !IDENTIFIER.test(value))) {
    throw new Error("Vocabulaire de prospection invalide.");
  }
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

function literalPattern(pattern: string): SQL {
  if (pattern.includes("'")) throw new Error("Motif SQL de prospection invalide.");
  return sql.raw(`'${pattern}'`);
}

function literalInt(value: number): SQL {
  if (!Number.isInteger(value)) throw new Error("Entier de prospection invalide.");
  return sql.raw(String(value));
}

function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  if (values.length === 1) {
    return sql`${column} = ${literalList(values)}`;
  }
  return sql`${column} IN (${literalList(values)})`;
}

function nullOrOneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IS NULL OR ${oneOf(column, values)}`;
}

function whenState(
  column: AnyPgColumn,
  states: readonly ProspectionState[],
  then: SQL,
): SQL {
  return sql`NOT (${oneOf(column, states)}) OR (${then})`;
}

function trimmedLength(column: AnyPgColumn, min: number, max: number): SQL {
  return sql`length(btrim(${column})) >= ${literalInt(min)} AND length(btrim(${column})) <= ${literalInt(max)}`;
}

function nullOrTrimmedLength(
  column: AnyPgColumn,
  min: number,
  max: number,
): SQL {
  return sql`${column} IS NULL OR ${trimmedLength(column, min, max)}`;
}

function matches(column: AnyPgColumn, pattern: string): SQL {
  return sql`${column} ~ ${literalPattern(pattern)}`;
}

export const PROSPECTION_HMAC_VERSION = 1;
export const PROSPECTION_MAX_SIGNAL_LENGTH = 200;

export const prospectionDossiers = pgTable(
  "prospection_dossiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug")
      .notNull()
      .references(() => novaluthProfilesTable.slug, { onDelete: "restrict" }),
    workshopName: text("workshop_name").notNull(),
    websiteUrl: text("website_url"),
    contactEmail: text("contact_email"),
    contactFirstName: text("contact_first_name"),
    state: text("state").notNull().default("opened"),
    lastReason: text("last_reason"),
    hook: text("hook"),
    hookOrigin: text("hook_origin"),
    hookValidatedAt: timestamp("hook_validated_at", { withTimezone: true }),
    hookValidatedByAccountId: integer(
      "hook_validated_by_account_id",
    ).references(() => novaluthPlatformAccountsTable.id, {
      onDelete: "restrict",
    }),
    verifiedSignals: text("verified_signals")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    followUpCount: integer("follow_up_count").notNull().default(0),
    revision: integer("revision").notNull().default(0),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
    check(
      "prospection_dossiers_state_known",
      oneOf(table.state, PROSPECTION_STATES),
    ),
    check(
      "prospection_dossiers_reason_known",
      nullOrOneOf(table.lastReason, PROSPECTION_REASONS),
    ),
    check(
      "prospection_dossiers_hook_origin_known",
      nullOrOneOf(table.hookOrigin, PROSPECTION_HOOK_ORIGINS),
    ),
    check("prospection_dossiers_slug_format", matches(table.slug, SLUG)),
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
    check(
      "prospection_dossiers_hook_length",
      nullOrTrimmedLength(table.hook, 40, 2000),
    ),
    check(
      "prospection_dossiers_signals_capped",
      sql`cardinality(${table.verifiedSignals}) <= ${literalInt(MAX_SIGNALS)}`,
    ),
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
    check(
      "prospection_dossiers_contact_required",
      whenState(
        table.state,
        POST_PROPOSAL_STATES,
        sql`${table.contactEmail} IS NOT NULL`,
      ),
    ),
    check(
      "prospection_dossiers_verified_at_required",
      whenState(
        table.state,
        POST_VERIFY_STATES,
        sql`${table.verifiedAt} IS NOT NULL`,
      ),
    ),
    check(
      "prospection_dossiers_proposed_at_required",
      whenState(
        table.state,
        POST_PROPOSAL_STATES,
        sql`${table.proposedAt} IS NOT NULL`,
      ),
    ),
    check(
      "prospection_dossiers_sent_at_required",
      whenState(table.state, POST_SEND_STATES, sql`${table.sentAt} IS NOT NULL`),
    ),
    check(
      "prospection_dossiers_replied_at_required",
      whenState(
        table.state,
        ["replied", "enrolled"],
        sql`${table.repliedAt} IS NOT NULL`,
      ),
    ),
    check(
      "prospection_dossiers_closed_at_required",
      whenState(
        table.state,
        TERMINAL_STATES,
        sql`${table.closedAt} IS NOT NULL`,
      ),
    ),
    check(
      "prospection_dossiers_live_has_no_closed_at",
      whenState(table.state, LIVE_STATES, sql`${table.closedAt} IS NULL`),
    ),
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
    recipientHmac: text("recipient_hmac").notNull(),
    recipientHmacVersion: integer("recipient_hmac_version")
      .notNull()
      .default(PROSPECTION_HMAC_VERSION),
    validatedByAccountId: integer("validated_by_account_id")
      .notNull()
      .references(() => novaluthPlatformAccountsTable.id, {
        onDelete: "restrict",
      }),
    validatedAt: timestamp("validated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    deliveryAllowed: boolean("delivery_allowed").notNull().default(false),
  },
  (table) => [
    uniqueIndex("prospection_proposals_active_key")
      .on(table.dossierId, table.kind)
      .where(sql`${table.withdrawnAt} IS NULL`),
    index("prospection_proposals_dossier_idx").on(table.dossierId),
    check(
      "prospection_proposals_kind_known",
      oneOf(table.kind, PROSPECTION_PROPOSAL_KINDS),
    ),
    check(
      "prospection_proposals_recipient_is_hmac",
      matches(table.recipientHmac, HEX64),
    ),
    check(
      "prospection_proposals_hmac_version_positive",
      sql`${table.recipientHmacVersion} >= ${literalInt(1)}`,
    ),
    check(
      "prospection_proposals_delivery_disabled_lot1",
      sql`${table.deliveryAllowed} = false`,
    ),
    check(
      "prospection_proposals_subject_length",
      trimmedLength(table.subject, 10, 200),
    ),
    check(
      "prospection_proposals_body_length",
      trimmedLength(table.body, 200, 8000),
    ),
    check(
      "prospection_proposals_withdrawn_after_validated",
      sql`${table.withdrawnAt} IS NULL OR ${table.withdrawnAt} >= ${table.validatedAt}`,
    ),
  ],
);

export const prospectionOppositions = pgTable(
  "prospection_oppositions",
  {
    emailHmac: text("email_hmac").notNull(),
    hmacVersion: integer("hmac_version")
      .notNull()
      .default(PROSPECTION_HMAC_VERSION),
    origin: text("origin").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "prospection_oppositions_pkey",
      columns: [table.emailHmac, table.hmacVersion],
    }),
    index("prospection_oppositions_version_idx").on(table.hmacVersion),
    check(
      "prospection_oppositions_is_hmac",
      matches(table.emailHmac, HEX64),
    ),
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
    measure: integer("measure"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("prospection_journal_dossier_idx").on(table.dossierId),
    index("prospection_journal_occurred_idx").on(table.occurredAt),
    check(
      "prospection_journal_event_known",
      oneOf(table.event, PROSPECTION_EVENTS),
    ),
    check(
      "prospection_journal_state_before_known",
      nullOrOneOf(table.stateBefore, PROSPECTION_STATES),
    ),
    check(
      "prospection_journal_state_after_known",
      nullOrOneOf(table.stateAfter, PROSPECTION_STATES),
    ),
    check(
      "prospection_journal_reason_known",
      nullOrOneOf(table.reason, PROSPECTION_REASONS),
    ),
    check(
      "prospection_journal_slug_format",
      matches(table.slug, SLUG),
    ),
    check(
      "prospection_journal_measure_positive",
      sql`${table.measure} IS NULL OR ${table.measure} >= ${literalInt(0)}`,
    ),
  ],
);

export type ProspectionDossier = typeof prospectionDossiers.$inferSelect;
export type NewProspectionDossier = typeof prospectionDossiers.$inferInsert;
export type ProspectionProposal = typeof prospectionProposals.$inferSelect;
export type NewProspectionProposal = typeof prospectionProposals.$inferInsert;
export type ProspectionOpposition = typeof prospectionOppositions.$inferSelect;
export type ProspectionJournalEntry = typeof prospectionJournal.$inferSelect;

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
};

export const PROSPECTION_TERMINAL_STATES: readonly ProspectionState[] =
  TERMINAL_STATES;
export const PROSPECTION_FOLLOW_UP_AFTER_DAYS = 8;
export const PROSPECTION_CLOSE_AFTER_DAYS = 21;
export const PROSPECTION_MAX_FOLLOW_UPS = 1;
export const PROSPECTION_MIN_SIGNALS = 2;
export const PROSPECTION_MAX_SIGNALS = MAX_SIGNALS;

export function isProspectionTransitionAllowed(
  from: ProspectionState,
  to: ProspectionState,
): boolean {
  return PROSPECTION_TRANSITIONS[from].includes(to);
}