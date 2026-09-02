import { sql } from "drizzle-orm";
import {
  check,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { novaluthProfilesTable } from "./novaluth";
import { novaluthProjectsTable } from "./novaluth-access";

export const protectedOrderStatuses = [
  "declaree",
  "confirmee",
  "expiree",
  "refusee",
  "annulee_client",
  "annulee_atelier",
  "livree",
  "non_confirmee",
] as const;

export const protectedOrderPaymentStatuses = [
  "non_du",
  "encaisse",
  "credit_utilise",
] as const;

export const protectedOrderCommissionStatuses = [
  "non_due",
  "encaisse",
] as const;

export const protectedOrderCreditStatuses = ["disponible", "utilise"] as const;

export const novaluthProtectedOrdersTable = pgTable(
  "novaluth_protected_orders",
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
    atelierEmail: text("atelier_email").notNull(),
    musicianEmail: text("musician_email").notNull(),
    priceCents: integer("price_cents").notNull(),
    depositCents: integer("deposit_cents").notNull().default(0),
    quoteReference: text("quote_reference"),
    description: text("description"),
    announcedDeliveryDate: date("announced_delivery_date", { mode: "string" }),
    status: text("status").notNull().default("declaree"),
    confirmationDeadline: timestamp("confirmation_deadline", {
      withTimezone: true,
    }).notNull(),
    receiptDeadline: timestamp("receipt_deadline", { withTimezone: true }),
    confirmationTokenHash: text("confirmation_token_hash").notNull().unique(),
    deliveryTokenHash: text("delivery_token_hash").unique(),
    commitmentFeeCents: integer("commitment_fee_cents").notNull().default(2900),
    commitmentPaymentStatus: text("commitment_payment_status")
      .notNull()
      .default("non_du"),
    commitmentPaymentReference: text("commitment_payment_reference").unique(),
    commissionCents: integer("commission_cents").notNull().default(0),
    commissionPaymentStatus: text("commission_payment_status")
      .notNull()
      .default("non_due"),
    commissionPaymentReference: text("commission_payment_reference").unique(),
    confirmationReminderSentAt: timestamp("confirmation_reminder_sent_at", {
      withTimezone: true,
    }),
    deliveryReminderSentAt: timestamp("delivery_reminder_sent_at", {
      withTimezone: true,
    }),
    declaredAt: timestamp("declared_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("novaluth_protected_orders_active_pair_unique")
      .on(table.atelierSlug, table.musicianEmail)
      .where(sql`${table.status} in ('declaree', 'confirmee')`),
    check(
      "novaluth_protected_orders_status_check",
      sql`${table.status} in ('declaree', 'confirmee', 'expiree', 'refusee', 'annulee_client', 'annulee_atelier', 'livree', 'non_confirmee')`,
    ),
    check(
      "novaluth_protected_orders_money_check",
      sql`${table.priceCents} > 0 and ${table.depositCents} >= 0 and ${table.depositCents} <= ${table.priceCents} and ${table.commitmentFeeCents} = 2900 and ${table.commissionCents} between 0 and 14900`,
    ),
    check(
      "novaluth_protected_orders_payment_check",
      sql`${table.commitmentPaymentStatus} in ('non_du', 'encaisse', 'credit_utilise') and ${table.commissionPaymentStatus} in ('non_due', 'encaisse')`,
    ),
  ],
);

export const novaluthProtectedOrderEventsTable = pgTable(
  "novaluth_protected_order_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orderId: integer("order_id")
      .notNull()
      .references(() => novaluthProtectedOrdersTable.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    metadata: jsonb("metadata").notNull().default({}),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const novaluthProtectedOrderCreditsTable = pgTable(
  "novaluth_protected_order_credits",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    atelierSlug: text("atelier_slug")
      .notNull()
      .references(() => novaluthProfilesTable.slug, { onDelete: "restrict" }),
    amountCents: integer("amount_cents").notNull().default(2900),
    sourceOrderId: integer("source_order_id").references(
      () => novaluthProtectedOrdersTable.id,
      { onDelete: "restrict" },
    ),
    appliedOrderId: integer("applied_order_id").references(
      () => novaluthProtectedOrdersTable.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("disponible"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "novaluth_protected_order_credits_amount_check",
      sql`${table.amountCents} = 2900`,
    ),
    check(
      "novaluth_protected_order_credits_status_check",
      sql`${table.status} in ('disponible', 'utilise')`,
    ),
  ],
);

export const insertProtectedOrderSchema = createInsertSchema(
  novaluthProtectedOrdersTable,
).omit({ updatedAt: true });

export type ProtectedOrder = typeof novaluthProtectedOrdersTable.$inferSelect;
export type InsertProtectedOrder = z.infer<typeof insertProtectedOrderSchema>;
export type ProtectedOrderEvent =
  typeof novaluthProtectedOrderEventsTable.$inferSelect;
export type ProtectedOrderCredit =
  typeof novaluthProtectedOrderCreditsTable.$inferSelect;