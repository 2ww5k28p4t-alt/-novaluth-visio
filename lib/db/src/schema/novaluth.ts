import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const novaluthProfilesTable = pgTable("novaluth_profiles", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
  entityType: text("entity_type").notNull(),
  country: text("country"),
  city: text("city"),
  status: text("status").notNull().default("candidate"),
  innovationScore: integer("innovation_score"),
  minimumPriceEur: integer("minimum_price_eur"),
  maximumPriceEur: integer("maximum_price_eur"),
  data: jsonb("data").notNull(),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const novaluthBriefsTable = pgTable("novaluth_briefs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  reference: text("reference")
    .notNull()
    .unique()
    .default(sql`'NL-' || upper(substr(md5(random()::text), 1, 8))`),
  criteria: jsonb("criteria").notNull(),
  email: text("email"),
  consent: boolean("consent").notNull().default(false),
  recommendations: jsonb("recommendations").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertNovaluthProfileSchema = createInsertSchema(
  novaluthProfilesTable,
).omit({ createdAt: true, updatedAt: true });
export const insertNovaluthBriefSchema = createInsertSchema(novaluthBriefsTable).omit({
  reference: true,
  createdAt: true,
});

export type NovaluthProfile = typeof novaluthProfilesTable.$inferSelect;
export type NovaluthBrief = typeof novaluthBriefsTable.$inferSelect;
export type InsertNovaluthProfile = z.infer<typeof insertNovaluthProfileSchema>;
export type InsertNovaluthBrief = z.infer<typeof insertNovaluthBriefSchema>;