import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import {
  db,
  novaluthProfilesTable,
  novaluthProtectedOrderCreditsTable,
  novaluthProtectedOrderEventsTable,
  novaluthProtectedOrdersTable,
  protectedOrderCommissionStatuses,
  protectedOrderPaymentStatuses,
  protectedOrderStatuses,
  type ProtectedOrder,
} from "@workspace/db";
import { getNovaLuthPublicUrl } from "./novaluth-email";
import {
  enqueueNovaLuthEmail,
  type NovaLuthDbExecutor,
} from "./novaluth-email-outbox";

export const PROTECTED_ORDER_COMMITMENT_FEE_CENTS = 2_900;
export const PROTECTED_ORDER_COMMISSION_CAP_CENTS = 14_900;
export const PROTECTED_ORDER_CONFIRMATION_DAYS = 7;
export const PROTECTED_ORDER_RECEIPT_DAYS = 30;

export type ProtectedOrderDecision = "confirmer" | "refuser";

export type ProtectedOrderInput = {
  session: string;
  email_musicien: string;
  email_atelier: string;
  prix_instrument_eur: number;
  acompte_eur?: number;
  reference_devis?: string;
  description?: string;
  date_livraison_annoncee?: string;
  reference_projet?: string;
};

export type ProtectedOrderView = {
  id: number;
  reference: string;
  atelier_slug: string;
  atelier_nom: string;
  email_musicien: string;
  prix_instrument_eur: number;
  acompte_eur: number;
  frais_engagement_eur: number;
  commission_eur: number;
  reference_devis: string | null;
  description: string | null;
  date_livraison_annoncee: string | null;
  statut: (typeof protectedOrderStatuses)[number];
  paiement_engagement: (typeof protectedOrderPaymentStatuses)[number];
  paiement_commission: (typeof protectedOrderCommissionStatuses)[number];
  echeance_confirmation: string;
  echeance_reception: string | null;
  declaree_le: string;
  confirmee_le: string | null;
  livree_le: string | null;
  annulee_le: string | null;
  peut_confirmer: boolean;
  peut_refuser: boolean;
  peut_annuler_musicien: boolean;
  peut_annuler_atelier: boolean;
  peut_confirmer_reception: boolean;
  lien_livraison: string | null;
};

export type AtelierProtectedOrderView = Omit<
  ProtectedOrderView,
  | "email_musicien"
  | "peut_confirmer"
  | "peut_refuser"
  | "peut_annuler_musicien"
  | "peut_confirmer_reception"
  | "lien_livraison"
>;

export type OrderMaintenanceResult = {
  expirations: number;
  relances_confirmation: number;
  relances_livraison: number;
  non_confirmees: number;
};

type OrderTransitionResult =
  | { ok: true; order: ProtectedOrder; deliveryToken?: string }
  | {
      ok: false;
      reason:
        | "not_found"
        | "already_decided"
        | "expired"
        | "invalid_state"
        | "conflict";
    };

type CreateProtectedOrderResult =
  | {
      order: ProtectedOrder;
      confirmationPath: string;
      confirmationUrl: string | null;
      emailQueued: boolean;
    }
  | { error: string };

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function newPrivateToken() {
  return randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
}

function privateUrl(path: string) {
  const base = getNovaLuthPublicUrl();
  return base ? `${base}${path}` : null;
}

function parseMoneyEuros(value: number | undefined, fallback = 0) {
  const cents = Math.round((value ?? fallback) * 100);
  return cents;
}

export function calculateProtectedOrderCommissionCents(priceCents: number) {
  return Math.min(
    PROTECTED_ORDER_COMMISSION_CAP_CENTS,
    Math.round(priceCents * 0.02),
  );
}

function validDateOnly(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function atelierName(data: unknown, fallback: string) {
  const raw = data as { nom?: unknown };
  return typeof raw.nom === "string" && raw.nom.trim() ? raw.nom : fallback;
}

async function getAtelierName(slug: string) {
  const [atelier] = await db
    .select({ data: novaluthProfilesTable.data })
    .from(novaluthProfilesTable)
    .where(eq(novaluthProfilesTable.slug, slug));
  return atelierName(atelier?.data, slug);
}

async function queueOrderEmail(
  executor: NovaLuthDbExecutor,
  recipient: string | null | undefined,
  order: ProtectedOrder,
  event:
    | "order_declared"
    | "order_confirmed"
    | "order_refused"
    | "order_confirmation_reminder"
    | "order_expired"
    | "order_delivery_reminder"
    | "order_delivered"
    | "order_client_cancelled"
    | "order_workshop_cancelled"
    | "order_not_confirmed",
  actionUrl: string | null,
  dedupeKey: string,
) {
  const queued = await enqueueNovaLuthEmail(
    executor,
    recipient,
    {
      event,
      reference: order.reference,
      portalUrl: actionUrl ?? "",
      actionUrl,
      atelierName: await getAtelierName(order.atelierSlug),
      amountCents: order.priceCents,
      commissionCents: order.commissionCents,
      accessEndsAt: order.receiptDeadline,
    },
    dedupeKey,
  );
  return queued;
}

async function addOrderEvent(
  executor: NovaLuthDbExecutor,
  order: ProtectedOrder,
  eventType: string,
  toStatus: string,
  metadata: Record<string, unknown>,
) {
  await executor.insert(novaluthProtectedOrderEventsTable).values({
    orderId: order.id,
    eventType,
    fromStatus: order.status,
    toStatus,
    metadata,
    idempotencyKey: `${eventType}:${order.id}:${toStatus}:${randomUUID()}`,
  });
}

function orderPath(reference: string, token: string) {
  return `/commandes/${reference}/confirmation/${token}`;
}

function deliveryPath(reference: string, token: string) {
  return `/commandes/${reference}/livraison/${token}`;
}

export async function createProtectedOrder(
  slug: string,
  input: ProtectedOrderInput,
): Promise<CreateProtectedOrderResult> {
  const musicianEmail = input.email_musicien.trim().toLowerCase();
  const atelierEmail = input.email_atelier.trim().toLowerCase();
  const priceCents = parseMoneyEuros(input.prix_instrument_eur);
  const depositCents = parseMoneyEuros(input.acompte_eur);
  const deliveryDate = input.date_livraison_annoncee
    ? validDateOnly(input.date_livraison_annoncee)
    : null;
  if (priceCents <= 0) return { error: "Le prix de l’instrument doit être supérieur à 0 €." } as const;
  if (depositCents < 0 || depositCents > priceCents) {
    return { error: "L’acompte doit être compris entre 0 € et le prix de l’instrument." } as const;
  }
  if (input.date_livraison_annoncee && !deliveryDate) {
    return { error: "La date de livraison annoncée est invalide." } as const;
  }

  const confirmationToken = newPrivateToken();
  const now = new Date();
  const created = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`protected-order:${slug}:${musicianEmail}`}))`,
    );
    const [existing] = await tx
      .select({ id: novaluthProtectedOrdersTable.id })
      .from(novaluthProtectedOrdersTable)
      .where(
        and(
          eq(novaluthProtectedOrdersTable.atelierSlug, slug),
          eq(novaluthProtectedOrdersTable.musicianEmail, musicianEmail),
          sql`${novaluthProtectedOrdersTable.status} in ('declaree', 'confirmee')`,
        ),
      );
    if (existing) return { error: "Une commande active existe déjà pour ce musicien." } as const;

    const reference = `CMD-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [order] = await tx
      .insert(novaluthProtectedOrdersTable)
      .values({
        reference,
        atelierSlug: slug,
        projectReference: input.reference_projet || null,
        atelierEmail,
        musicianEmail,
        priceCents,
        depositCents,
        quoteReference: input.reference_devis || null,
        description: input.description || null,
        announcedDeliveryDate: deliveryDate,
        confirmationDeadline: addDays(now, PROTECTED_ORDER_CONFIRMATION_DAYS),
        confirmationTokenHash: hashToken(confirmationToken),
      })
      .returning();
    if (!order) {
      throw new Error("La commande protégée n’a pas pu être créée.");
    }
    await addOrderEvent(tx, order, "declared", "declaree", {
      priceCents,
      depositCents,
    });
    const confirmationUrl = privateUrl(orderPath(order.reference, confirmationToken));
    const email = await queueOrderEmail(
      tx,
      order.musicianEmail,
      order,
      "order_declared",
      confirmationUrl,
      `order_declared:${order.id}`,
    );
    return { order, confirmationToken, emailQueued: email.queued };
  });
  if (!("confirmationToken" in created) || !created.order) {
    return { error: created.error ?? "La commande protégée existe déjà." };
  }
  return {
    order: created.order,
    confirmationPath: orderPath(created.order.reference, created.confirmationToken),
    confirmationUrl: privateUrl(
      orderPath(created.order.reference, created.confirmationToken),
    ),
    emailQueued: created.emailQueued,
  } as const;
}

async function findOrderByToken(token: string, kind: "confirmation" | "delivery") {
  const column =
    kind === "confirmation"
      ? novaluthProtectedOrdersTable.confirmationTokenHash
      : novaluthProtectedOrdersTable.deliveryTokenHash;
  const [order] = await db
    .select()
    .from(novaluthProtectedOrdersTable)
    .where(eq(column, hashToken(token)));
  return order ?? null;
}

async function toView(
  order: ProtectedOrder,
  kind: "confirmation" | "delivery",
): Promise<ProtectedOrderView> {
  const name = await getAtelierName(order.atelierSlug);
  const now = new Date();
  return {
    id: order.id,
    reference: order.reference,
    atelier_slug: order.atelierSlug,
    atelier_nom: name,
    email_musicien: order.musicianEmail,
    prix_instrument_eur: order.priceCents / 100,
    acompte_eur: order.depositCents / 100,
    frais_engagement_eur: order.commitmentFeeCents / 100,
    commission_eur: order.commissionCents / 100,
    reference_devis: order.quoteReference,
    description: order.description,
    date_livraison_annoncee: order.announcedDeliveryDate,
    statut: order.status as ProtectedOrderView["statut"],
    paiement_engagement: order.commitmentPaymentStatus as ProtectedOrderView["paiement_engagement"],
    paiement_commission: order.commissionPaymentStatus as ProtectedOrderView["paiement_commission"],
    echeance_confirmation: order.confirmationDeadline.toISOString(),
    echeance_reception: order.receiptDeadline?.toISOString() ?? null,
    declaree_le: order.declaredAt.toISOString(),
    confirmee_le: order.confirmedAt?.toISOString() ?? null,
    livree_le: order.deliveredAt?.toISOString() ?? null,
    annulee_le: order.cancelledAt?.toISOString() ?? null,
    peut_confirmer:
      kind === "confirmation" &&
      order.status === "declaree" &&
      order.confirmationDeadline > now,
    peut_refuser: kind === "confirmation" && order.status === "declaree",
    peut_annuler_musicien:
      kind === "confirmation" && order.status === "confirmee",
    peut_annuler_atelier:
      kind === "confirmation" &&
      (order.status === "declaree" || order.status === "confirmee"),
    peut_confirmer_reception:
      kind === "delivery" &&
      order.status === "confirmee" &&
      (!order.receiptDeadline || order.receiptDeadline > now),
    lien_livraison: null,
  };
}

export async function getProtectedOrderView(
  token: string,
  kind: "confirmation" | "delivery",
) {
  const order = await findOrderByToken(token, kind);
  return order ? toView(order, kind) : null;
}

export async function protectedOrderViewFromOrder(
  order: ProtectedOrder,
  kind: "confirmation" | "delivery" = "confirmation",
) {
  return toView(order, kind);
}

export async function listProtectedOrdersForAtelier(slug: string) {
  const orders = await db
    .select()
    .from(novaluthProtectedOrdersTable)
    .where(eq(novaluthProtectedOrdersTable.atelierSlug, slug))
    .orderBy(asc(novaluthProtectedOrdersTable.declaredAt));
  return Promise.all(
    orders.map(async (order) => {
      const view = await toView(order, "confirmation");
      return view as AtelierProtectedOrderView;
    }),
  );
}

export async function decideProtectedOrder(
  token: string,
  decision: ProtectedOrderDecision,
): Promise<OrderTransitionResult> {
  const confirmationHash = hashToken(token);
  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(novaluthProtectedOrdersTable)
      .where(eq(novaluthProtectedOrdersTable.confirmationTokenHash, confirmationHash));
    if (!current) return { ok: false as const, reason: "not_found" as const };
    if (current.status !== "declaree") {
      return {
        ok: false as const,
        reason:
          current.status === "expiree" ? ("expired" as const) : ("already_decided" as const),
      };
    }
    if (current.confirmationDeadline <= new Date()) {
      return { ok: false as const, reason: "expired" as const };
    }

    if (decision === "refuser") {
      const [updated] = await tx
        .update(novaluthProtectedOrdersTable)
        .set({ status: "refusee", cancelledAt: new Date() })
        .where(
          and(
            eq(novaluthProtectedOrdersTable.id, current.id),
            eq(novaluthProtectedOrdersTable.status, "declaree"),
          ),
        )
        .returning();
      if (!updated) return { ok: false as const, reason: "conflict" as const };
      await addOrderEvent(tx, current, "refused", "refusee", {});
      const url = privateUrl(orderPath(current.reference, token));
      await queueOrderEmail(tx, current.atelierEmail, updated, "order_refused", url, `order_refused:${current.id}`);
      return { ok: true as const, order: updated };
    }

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`protected-order-credit:${current.atelierSlug}`}))`,
    );
    const [credit] = await tx
      .select()
      .from(novaluthProtectedOrderCreditsTable)
      .where(
        and(
          eq(novaluthProtectedOrderCreditsTable.atelierSlug, current.atelierSlug),
          eq(novaluthProtectedOrderCreditsTable.status, "disponible"),
        ),
      )
      .orderBy(asc(novaluthProtectedOrderCreditsTable.createdAt))
      .limit(1);
    const deliveryToken = newPrivateToken();
    const confirmedAt = new Date();
    const receiptDeadline = current.announcedDeliveryDate
      ? addDays(new Date(`${current.announcedDeliveryDate}T00:00:00.000Z`), PROTECTED_ORDER_RECEIPT_DAYS)
      : null;
    const [updated] = await tx
      .update(novaluthProtectedOrdersTable)
      .set({
        status: "confirmee",
        commitmentPaymentStatus: credit ? "credit_utilise" : "encaisse",
        commitmentPaymentReference: credit
          ? null
          : `sim_engagement_${randomUUID()}`,
        deliveryTokenHash: hashToken(deliveryToken),
        receiptDeadline,
        confirmedAt,
      })
      .where(
        and(
          eq(novaluthProtectedOrdersTable.id, current.id),
          eq(novaluthProtectedOrdersTable.status, "declaree"),
        ),
      )
      .returning();
    if (!updated) return { ok: false as const, reason: "conflict" as const };
    if (credit) {
      await tx
        .update(novaluthProtectedOrderCreditsTable)
        .set({
          status: "utilise",
          appliedOrderId: updated.id,
          appliedAt: confirmedAt,
        })
        .where(
          and(
            eq(novaluthProtectedOrderCreditsTable.id, credit.id),
            eq(novaluthProtectedOrderCreditsTable.status, "disponible"),
          ),
        );
    }
    await addOrderEvent(tx, current, "confirmed", "confirmee", {
      commitmentPaymentStatus: updated.commitmentPaymentStatus,
      creditId: credit?.id ?? null,
    });
    const deliveryUrl = privateUrl(
      deliveryPath(updated.reference, deliveryToken),
    );
    await queueOrderEmail(
      tx,
      updated.atelierEmail,
      updated,
      "order_confirmed",
      deliveryUrl,
      `order_confirmed:atelier:${updated.id}`,
    );
    await queueOrderEmail(
      tx,
      updated.musicianEmail,
      updated,
      "order_confirmed",
      deliveryUrl,
      `order_confirmed:musician:${updated.id}`,
    );
    return { ok: true as const, order: updated, deliveryToken };
  });
  return result;
}

export async function confirmProtectedOrderDelivery(
  token: string,
): Promise<OrderTransitionResult> {
  const deliveryHash = hashToken(token);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(novaluthProtectedOrdersTable)
      .where(eq(novaluthProtectedOrdersTable.deliveryTokenHash, deliveryHash));
    if (!current) return { ok: false as const, reason: "not_found" as const };
    if (current.status !== "confirmee") {
      return { ok: false as const, reason: "invalid_state" as const };
    }
    if (current.receiptDeadline && current.receiptDeadline <= new Date()) {
      return { ok: false as const, reason: "expired" as const };
    }
    const deliveredAt = new Date();
    const [updated] = await tx
      .update(novaluthProtectedOrdersTable)
      .set({
        status: "livree",
        commissionCents: calculateProtectedOrderCommissionCents(current.priceCents),
        commissionPaymentStatus: "encaisse",
        commissionPaymentReference: `sim_commission_${randomUUID()}`,
        deliveredAt,
      })
      .where(
        and(
          eq(novaluthProtectedOrdersTable.id, current.id),
          eq(novaluthProtectedOrdersTable.status, "confirmee"),
          eq(novaluthProtectedOrdersTable.commissionPaymentStatus, "non_due"),
        ),
      )
      .returning();
    if (!updated) return { ok: false as const, reason: "conflict" as const };
    await addOrderEvent(tx, current, "delivered", "livree", {
      commissionCents: updated.commissionCents,
    });
    const url = privateUrl(deliveryPath(updated.reference, token));
    await queueOrderEmail(tx, updated.atelierEmail, updated, "order_delivered", url, `order_delivered:atelier:${updated.id}`);
    await queueOrderEmail(tx, updated.musicianEmail, updated, "order_delivered", url, `order_delivered:musician:${updated.id}`);
    return { ok: true as const, order: updated };
  });
}

export async function cancelProtectedOrderByMusician(
  token: string,
): Promise<OrderTransitionResult> {
  const confirmationHash = hashToken(token);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(novaluthProtectedOrdersTable)
      .where(eq(novaluthProtectedOrdersTable.confirmationTokenHash, confirmationHash));
    if (!current) return { ok: false as const, reason: "not_found" as const };
    if (current.status !== "confirmee") {
      return { ok: false as const, reason: "invalid_state" as const };
    }
    const cancelledAt = new Date();
    const [updated] = await tx
      .update(novaluthProtectedOrdersTable)
      .set({ status: "annulee_client", cancelledAt })
      .where(
        and(
          eq(novaluthProtectedOrdersTable.id, current.id),
          eq(novaluthProtectedOrdersTable.status, "confirmee"),
        ),
      )
      .returning();
    if (!updated) return { ok: false as const, reason: "conflict" as const };
    await tx.insert(novaluthProtectedOrderCreditsTable).values({
      atelierSlug: updated.atelierSlug,
      sourceOrderId: updated.id,
      amountCents: PROTECTED_ORDER_COMMITMENT_FEE_CENTS,
    });
    await addOrderEvent(tx, current, "cancelled_by_musician", "annulee_client", {
      creditCents: PROTECTED_ORDER_COMMITMENT_FEE_CENTS,
    });
    const url = privateUrl(orderPath(updated.reference, token));
    await queueOrderEmail(tx, updated.atelierEmail, updated, "order_client_cancelled", url, `order_client_cancelled:${updated.id}`);
    return { ok: true as const, order: updated };
  });
}

export async function cancelProtectedOrderByAtelier(
  slug: string,
  orderId: number,
): Promise<OrderTransitionResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(novaluthProtectedOrdersTable)
      .where(
        and(
          eq(novaluthProtectedOrdersTable.id, orderId),
          eq(novaluthProtectedOrdersTable.atelierSlug, slug),
        ),
      );
    if (!current) return { ok: false as const, reason: "not_found" as const };
    if (current.status !== "declaree" && current.status !== "confirmee") {
      return { ok: false as const, reason: "invalid_state" as const };
    }
    const [updated] = await tx
      .update(novaluthProtectedOrdersTable)
      .set({ status: "annulee_atelier", cancelledAt: new Date() })
      .where(
        and(
          eq(novaluthProtectedOrdersTable.id, orderId),
          eq(novaluthProtectedOrdersTable.atelierSlug, slug),
          sql`${novaluthProtectedOrdersTable.status} in ('declaree', 'confirmee')`,
        ),
      )
      .returning();
    if (!updated) return { ok: false as const, reason: "conflict" as const };
    await addOrderEvent(tx, current, "cancelled_by_workshop", "annulee_atelier", {});
    await queueOrderEmail(tx, updated.musicianEmail, updated, "order_workshop_cancelled", null, `order_workshop_cancelled:${updated.id}`);
    return { ok: true as const, order: updated };
  });
}

async function expireDeclaredOrder(order: ProtectedOrder, now: Date) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(novaluthProtectedOrdersTable)
      .set({ status: "expiree", cancelledAt: now })
      .where(
        and(
          eq(novaluthProtectedOrdersTable.id, order.id),
          eq(novaluthProtectedOrdersTable.status, "declaree"),
          lte(novaluthProtectedOrdersTable.confirmationDeadline, now),
        ),
      )
      .returning();
    if (!updated) return false;
    await addOrderEvent(tx, order, "expired", "expiree", {});
    await queueOrderEmail(tx, updated.musicianEmail, updated, "order_expired", null, `order_expired:musician:${updated.id}`);
    await queueOrderEmail(tx, updated.atelierEmail, updated, "order_expired", null, `order_expired:atelier:${updated.id}`);
    return true;
  });
}

export async function runProtectedOrderMaintenance(
  maintenanceNow = new Date(),
): Promise<OrderMaintenanceResult> {
  const now = maintenanceNow;
  const orders = await db
    .select()
    .from(novaluthProtectedOrdersTable)
    .where(
      sql`${novaluthProtectedOrdersTable.status} in ('declaree', 'confirmee')`,
    );
  let expirations = 0;
  let relancesConfirmation = 0;
  let relancesLivraison = 0;
  let nonConfirmees = 0;

  for (const order of orders) {
    if (order.status === "declaree") {
      if (order.confirmationDeadline <= now) {
        if (await expireDeclaredOrder(order, now)) expirations += 1;
      } else if (
        order.confirmationDeadline.getTime() - now.getTime() <= 4 * 24 * 60 * 60 * 1000 &&
        !order.confirmationReminderSentAt
      ) {
        const queued = await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(novaluthProtectedOrdersTable)
            .set({ confirmationReminderSentAt: now })
            .where(
              and(
                eq(novaluthProtectedOrdersTable.id, order.id),
                isNull(novaluthProtectedOrdersTable.confirmationReminderSentAt),
              ),
            )
            .returning();
          if (!updated) return false;
          await queueOrderEmail(
            tx,
            order.musicianEmail,
            updated,
            "order_confirmation_reminder",
            null,
            `order_confirmation_reminder:${order.id}`,
          );
          return true;
        });
        if (queued) relancesConfirmation += 1;
      }
    } else if (order.receiptDeadline && order.receiptDeadline <= now) {
      const updated = await db.transaction(async (tx) => {
        const [changed] = await tx
          .update(novaluthProtectedOrdersTable)
          .set({ status: "non_confirmee" })
          .where(
            and(
              eq(novaluthProtectedOrdersTable.id, order.id),
              eq(novaluthProtectedOrdersTable.status, "confirmee"),
              lte(novaluthProtectedOrdersTable.receiptDeadline, now),
            ),
          )
          .returning();
        if (!changed) return false;
        await addOrderEvent(tx, order, "receipt_not_confirmed", "non_confirmee", {});
        await queueOrderEmail(tx, changed.musicianEmail, changed, "order_not_confirmed", null, `order_not_confirmed:musician:${changed.id}`);
        await queueOrderEmail(tx, changed.atelierEmail, changed, "order_not_confirmed", null, `order_not_confirmed:atelier:${changed.id}`);
        return true;
      });
      if (updated) nonConfirmees += 1;
    } else if (
      order.receiptDeadline &&
      order.receiptDeadline.getTime() - now.getTime() <= 7 * 24 * 60 * 60 * 1000 &&
      !order.deliveryReminderSentAt
    ) {
      const queued = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(novaluthProtectedOrdersTable)
          .set({ deliveryReminderSentAt: now })
          .where(
            and(
              eq(novaluthProtectedOrdersTable.id, order.id),
              isNull(novaluthProtectedOrdersTable.deliveryReminderSentAt),
            ),
          )
          .returning();
        if (!updated) return false;
        await queueOrderEmail(
          tx,
          updated.musicianEmail,
          updated,
          "order_delivery_reminder",
          null,
          `order_delivery_reminder:${updated.id}`,
        );
        return true;
      });
      if (queued) relancesLivraison += 1;
    }
  }
  return {
    expirations,
    relances_confirmation: relancesConfirmation,
    relances_livraison: relancesLivraison,
    non_confirmees: nonConfirmees,
  };
}
