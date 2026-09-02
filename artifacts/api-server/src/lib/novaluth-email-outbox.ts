import { sql } from "drizzle-orm";
import {
  db,
  novaluthEmailOutboxTable,
  type NovaluthEmailOutbox,
} from "@workspace/db";
import {
  sendNovaLuthEmail,
  type EmailDetails,
  NovaLuthEmailError,
} from "./novaluth-email";
import { logger } from "./logger";

const MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 30_000;
const MAX_ERROR_LENGTH = 2_000;

export type NovaLuthDbExecutor = Pick<typeof db, "insert">;

type StoredEmailDetails = Omit<EmailDetails, "accessEndsAt"> & {
  accessEndsAt?: string | null;
};

type ClaimedEmail = Pick<
  NovaluthEmailOutbox,
  | "id"
  | "dedupeKey"
  | "recipient"
  | "event"
  | "payload"
  | "attempts"
>;

export async function enqueueNovaLuthEmail(
  executor: NovaLuthDbExecutor,
  recipient: string | null | undefined,
  details: EmailDetails,
  dedupeKey: string,
) {
  if (!recipient) {
    return { queued: false as const, reason: "no_recipient" as const };
  }

  const payload: StoredEmailDetails = {
    ...details,
    accessEndsAt: details.accessEndsAt?.toISOString() ?? null,
  };
  const [inserted] = await executor
    .insert(novaluthEmailOutboxTable)
    .values({
      dedupeKey,
      recipient,
      event: details.event,
      payload,
    })
    .onConflictDoNothing({ target: novaluthEmailOutboxTable.dedupeKey })
    .returning({ id: novaluthEmailOutboxTable.id });

  if (inserted) {
    logger.info(
      { outboxId: inserted.id, event: details.event, dedupeKey },
      "NovaLuth email queued",
    );
    return { queued: true as const, deduplicated: false as const, id: inserted.id };
  }

  logger.info({ event: details.event, dedupeKey }, "NovaLuth email already queued");
  return { queued: true as const, deduplicated: true as const };
}

function toEmailDetails(payload: unknown): EmailDetails {
  const raw = payload as StoredEmailDetails;
  return {
    ...raw,
    accessEndsAt: raw.accessEndsAt ? new Date(raw.accessEndsAt) : null,
  };
}

function backoffMs(attempts: number) {
  return Math.min(12 * 60 * 60 * 1000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

async function claimEmails(limit: number): Promise<ClaimedEmail[]> {
  await db.execute(sql`
    update novaluth_email_outbox
    set
      status = 'dead',
      lease_until = null,
      last_error = 'Worker lease expired after the retry limit.',
      updated_at = now()
    where status = 'processing'
      and lease_until < now()
      and attempts >= ${MAX_ATTEMPTS}
  `);
  const result = await db.execute(sql`
    with candidates as (
      select id
      from novaluth_email_outbox
      where (
        status in ('pending', 'failed')
        and available_at <= now()
        and attempts < ${MAX_ATTEMPTS}
      ) or (
        status = 'processing'
        and lease_until < now()
        and attempts < ${MAX_ATTEMPTS}
      )
      order by available_at asc, id asc
      for update skip locked
      limit ${limit}
    )
    update novaluth_email_outbox as outbox
    set
      status = 'processing',
      attempts = outbox.attempts + 1,
      lease_until = now() + (${LEASE_MS} * interval '1 millisecond'),
      updated_at = now(),
      last_error = case
        when outbox.status = 'processing' then 'Worker lease expired before completion.'
        else outbox.last_error
      end
    from candidates
    where outbox.id = candidates.id
    returning
      outbox.id,
      outbox.dedupe_key as "dedupeKey",
      outbox.recipient,
      outbox.event,
      outbox.payload,
      outbox.attempts;
  `);
  return result.rows as unknown as ClaimedEmail[];
}

async function markSent(id: number, providerMessageId?: string) {
  await db.execute(sql`
    update novaluth_email_outbox
    set
      status = 'sent',
      lease_until = null,
      provider_message_id = ${providerMessageId ?? null},
      last_error = null,
      last_status_code = null,
      sent_at = now(),
      updated_at = now()
    where id = ${id} and status = 'processing'
  `);
}

async function markFailed(id: number, attempts: number, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_ERROR_LENGTH,
  );
  const retryable = error instanceof NovaLuthEmailError ? error.retryable : true;
  const statusCode = error instanceof NovaLuthEmailError ? error.statusCode ?? null : null;
  const dead = !retryable || attempts >= MAX_ATTEMPTS;
  const availableAt = new Date(Date.now() + backoffMs(attempts));

  await db.execute(sql`
    update novaluth_email_outbox
    set
      status = ${dead ? "dead" : "failed"},
      available_at = ${availableAt},
      lease_until = null,
      last_error = ${message},
      last_status_code = ${statusCode},
      updated_at = now()
    where id = ${id} and status = 'processing'
  `);
  logger[dead ? "error" : "warn"](
    { outboxId: id, attempts, retryable, statusCode, error: message },
    dead ? "NovaLuth email moved to dead letter" : "NovaLuth email scheduled for retry",
  );
}

export async function processNovaLuthEmailOutbox(limit = 10) {
  const claimed = await claimEmails(limit);
  let sent = 0;
  let failed = 0;
  for (const email of claimed) {
    try {
      const result = await sendNovaLuthEmail(
        email.recipient,
        toEmailDetails(email.payload),
        { idempotencyKey: email.dedupeKey },
      );
      await markSent(email.id, result.sent ? result.providerMessageId : undefined);
      sent += 1;
    } catch (error) {
      await markFailed(email.id, email.attempts, error);
      failed += 1;
    }
  }
  if (claimed.length) {
    logger.info({ claimed: claimed.length, sent, failed }, "NovaLuth email outbox processed");
  }
  return { claimed: claimed.length, sent, failed };
}

export async function getNovaLuthEmailOutboxSummary() {
  const result = await db.execute(sql`
    select
      status,
      count(*)::int as count,
      min(created_at) as oldest_created_at,
      min(available_at) as next_available_at
    from novaluth_email_outbox
    group by status
    order by status
  `);
  return result.rows as unknown as Array<{
    status: string;
    count: number;
    oldest_created_at: Date | null;
    next_available_at: Date | null;
  }>;
}

export function startNovaLuthEmailWorker() {
  const intervalMs = Number(process.env.NOVALUTH_EMAIL_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (!running) return;
    try {
      await processNovaLuthEmailOutbox();
    } catch (error) {
      logger.error({ err: error }, "NovaLuth email outbox worker failed");
    } finally {
      if (running) {
        timer = setTimeout(tick, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS);
        timer.unref();
      }
    }
  };
  running = true;
  void tick();
  return () => {
    running = false;
    if (timer) clearTimeout(timer);
  };
}