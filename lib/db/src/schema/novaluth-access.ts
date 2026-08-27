import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { novaluthProfilesTable } from "./novaluth";

export const novaluthProjectsTable = pgTable("novaluth_projects", {
  reference: text("reference").primaryKey(),
  musicianToken: text("musician_token").notNull().unique(),
  email: text("email"),
  status: text("status").notNull().default("actif"),
  criteria: jsonb("criteria").notNull(),
  recommendedAteliers: jsonb("recommended_ateliers").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
});

export const novaluthAtelierSessionsTable = pgTable("novaluth_atelier_sessions", {
  token: text("token").primaryKey(),
  atelierSlug: text("atelier_slug")
    .notNull()
    .references(() => novaluthProfilesTable.slug, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export const novaluthAccessRequestsTable = pgTable("novaluth_access_requests", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectReference: text("project_reference")
    .notNull()
    .references(() => novaluthProjectsTable.reference, { onDelete: "cascade" }),
  atelierSlug: text("atelier_slug")
    .notNull()
    .references(() => novaluthProfilesTable.slug, { onDelete: "cascade" }),
  plan: text("plan").notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull().default("en_attente"),
  paymentStatus: text("payment_status").notNull().default("preautorise"),
  paymentReference: text("payment_reference").notNull().unique(),
  followupCredits: integer("followup_credits").notNull().default(0),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  accessEndsAt: timestamp("access_ends_at", { withTimezone: true }),
  lastFollowupAt: timestamp("last_followup_at", { withTimezone: true }),
  reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertNovaluthProjectSchema = createInsertSchema(novaluthProjectsTable).omit({
  createdAt: true,
  lastActivityAt: true,
});
export const insertNovaluthAtelierSessionSchema = createInsertSchema(novaluthAtelierSessionsTable).omit({
  createdAt: true,
  lastSeenAt: true,
});
export const insertNovaluthAccessRequestSchema = createInsertSchema(novaluthAccessRequestsTable).omit({
  requestedAt: true,
  updatedAt: true,
});

export type NovaluthProject = typeof novaluthProjectsTable.$inferSelect;
export type NovaluthAtelierSession = typeof novaluthAtelierSessionsTable.$inferSelect;
export type NovaluthAccessRequest = typeof novaluthAccessRequestsTable.$inferSelect;
export type InsertNovaluthProject = z.infer<typeof insertNovaluthProjectSchema>;
export type InsertNovaluthAtelierSession = z.infer<typeof insertNovaluthAtelierSessionSchema>;
export type InsertNovaluthAccessRequest = z.infer<typeof insertNovaluthAccessRequestSchema>;