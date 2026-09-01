import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const novaluthGatewayNoncesTable = pgTable("novaluth_gateway_nonces", {
  nonce: text("nonce").primaryKey(),
  caller: text("caller").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const novaluthGatewayDailyQuotasTable = pgTable(
  "novaluth_gateway_daily_quotas",
  {
    day: text("day").notNull(),
    operation: text("operation").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("novaluth_gateway_daily_quotas_day_operation_unique").on(table.day, table.operation)],
);

export const novaluthGatewayDomainVisitsTable = pgTable("novaluth_gateway_domain_visits", {
  domain: text("domain").primaryKey(),
  nextAllowedAt: timestamp("next_allowed_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const novaluthSn13DiagnosticsTable = pgTable(
  "novaluth_sn13_diagnostics",
  {
    key: text("key").primaryKey(),
    status: text("status").notNull(),
    requestId: text("request_id"),
    errorBody: text("error_body"),
    calledAt: timestamp("called_at", { withTimezone: true }).notNull(),
    resultCount: integer("result_count"),
  },
  (table) => [
    check(
      "novaluth_sn13_diagnostics_status_check",
      sql`${table.status} in ('succes', 'vide', 'incomplet', 'erreur')`,
    ),
    check(
      "novaluth_sn13_diagnostics_request_id_length_check",
      sql`${table.requestId} is null or char_length(${table.requestId}) <= 200`,
    ),
    check(
      "novaluth_sn13_diagnostics_error_body_length_check",
      sql`${table.errorBody} is null or char_length(${table.errorBody}) <= 4000`,
    ),
    check(
      "novaluth_sn13_diagnostics_result_count_check",
      sql`${table.resultCount} is null or ${table.resultCount} >= 0`,
    ),
  ],
);

export const novaluthSn13CallEventsTable = pgTable(
  "novaluth_sn13_call_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    status: text("status").notNull(),
    calledAt: timestamp("called_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("novaluth_sn13_call_events_called_at_idx").on(table.calledAt),
    check(
      "novaluth_sn13_call_events_status_check",
      sql`${table.status} in ('succes', 'vide', 'incomplet', 'erreur')`,
    ),
  ],
);

export const novaluthSn13AlertStateTable = pgTable("novaluth_sn13_alert_state", {
  key: text("key").primaryKey(),
  active: boolean("active").notNull().default(false),
  episodeStartedAt: timestamp("episode_started_at", { withTimezone: true }),
  recoveredAt: timestamp("recovered_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const novaluthSn13PurgeIncidentsTable = pgTable(
  "novaluth_sn13_purge_incidents",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    recoveredAt: timestamp("recovered_at", { withTimezone: true }),
  },
  (table) => [
    index("novaluth_sn13_purge_incidents_started_at_idx").on(table.startedAt),
  ],
);