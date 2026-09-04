import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { novaluthProfilesTable } from "./novaluth";

export const novaluthPlatformAccountsTable = pgTable(
  "novaluth_platform_accounts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    login: text("login").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role").notNull().default("musicien"),
    atelierSlug: text("atelier_slug").references(() => novaluthProfilesTable.slug, {
      onDelete: "set null",
    }),
    passwordHash: text("password_hash").notNull(),
    active: boolean("active").notNull().default(true),
    mustChangePassword: boolean("must_change_password").notNull().default(true),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("novaluth_platform_accounts_login_unique").on(sql`lower(${table.login})`),
    check(
      "novaluth_platform_accounts_role_check",
      sql`${table.role} in ('admin', 'artisan', 'musicien')`,
    ),
  ],
);

export const novaluthPlatformSessionsTable = pgTable("novaluth_platform_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  accountId: integer("account_id")
    .notNull()
    .references(() => novaluthPlatformAccountsTable.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertNovaluthPlatformAccountSchema = createInsertSchema(
  novaluthPlatformAccountsTable,
).omit({
  createdAt: true,
  updatedAt: true,
});
export const insertNovaluthPlatformSessionSchema = createInsertSchema(
  novaluthPlatformSessionsTable,
).omit({
  createdAt: true,
  lastSeenAt: true,
});

export type NovaluthPlatformAccount = typeof novaluthPlatformAccountsTable.$inferSelect;
export type NovaluthPlatformSession = typeof novaluthPlatformSessionsTable.$inferSelect;
export type InsertNovaluthPlatformAccount = z.infer<
  typeof insertNovaluthPlatformAccountSchema
>;
export type InsertNovaluthPlatformSession = z.infer<
  typeof insertNovaluthPlatformSessionSchema
>;