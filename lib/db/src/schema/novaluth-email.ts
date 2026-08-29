import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const novaluthEmailOutboxTable = pgTable(
  "novaluth_email_outbox",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    dedupeKey: text("dedupe_key").notNull(),
    recipient: text("recipient").notNull(),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    lastStatusCode: integer("last_status_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("novaluth_email_outbox_dedupe_key_unique").on(table.dedupeKey),
    check(
      "novaluth_email_outbox_status_check",
      sql`${table.status} in ('pending', 'processing', 'sent', 'failed', 'dead')`,
    ),
    check("novaluth_email_outbox_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export type NovaluthEmailOutbox = typeof novaluthEmailOutboxTable.$inferSelect;