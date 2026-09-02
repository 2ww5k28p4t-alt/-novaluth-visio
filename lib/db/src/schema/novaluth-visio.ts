import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { novaluthProtectedOrdersTable } from "./novaluth-orders";
import { novaluthProfilesTable } from "./novaluth";
import { novaluthProjectsTable } from "./novaluth-access";

export const novaluthVisioPurposes = [
  "projet",
  "bois",
  "assemblage",
  "finition",
  "final",
  "autre",
] as const;

export const novaluthVisioStatuses = ["active", "annulee", "expiree"] as const;

export const novaluthVisioAppointmentsTable = pgTable(
  "novaluth_visio_appointments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    reference: text("reference").notNull().unique(),
    atelierSlug: text("atelier_slug")
      .notNull()
      .references(() => novaluthProfilesTable.slug, { onDelete: "restrict" }),
    projectReference: text("project_reference").references(
      () => novaluthProjectsTable.reference,
      { onDelete: "set null" },
    ),
    orderId: integer("order_id").references(() => novaluthProtectedOrdersTable.id, {
      onDelete: "set null",
    }),
    atelierEmail: text("atelier_email").notNull(),
    musicianEmail: text("musician_email").notNull(),
    purpose: text("purpose").notNull().default("projet"),
    roomName: text("room_name").notNull(),
    atelierTokenHash: text("atelier_token_hash").notNull().unique(),
    musicianTokenHash: text("musician_token_hash").notNull().unique(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    atelierJoinedAt: timestamp("atelier_joined_at", { withTimezone: true }),
    musicianJoinedAt: timestamp("musician_joined_at", { withTimezone: true }),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("novaluth_visio_active_room_unique")
      .on(table.roomName)
      .where(sql`${table.cancelledAt} is null`),
    check(
      "novaluth_visio_purpose_check",
      sql`${table.purpose} in ('projet', 'bois', 'assemblage', 'finition', 'final', 'autre')`,
    ),
    check(
      "novaluth_visio_participants_check",
      sql`length(trim(${table.atelierEmail})) >= 3 and length(trim(${table.musicianEmail})) >= 3`,
    ),
  ],
);

export const insertNovaluthVisioAppointmentSchema = createInsertSchema(
  novaluthVisioAppointmentsTable,
).omit({
  createdAt: true,
  updatedAt: true,
});

export type NovaluthVisioAppointment =
  typeof novaluthVisioAppointmentsTable.$inferSelect;
export type InsertNovaluthVisioAppointment = z.infer<
  typeof insertNovaluthVisioAppointmentSchema
>;