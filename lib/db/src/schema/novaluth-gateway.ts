import { integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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