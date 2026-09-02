import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import {
  createHash,
  createPrivateKey,
  createSign,
  randomBytes,
} from "node:crypto";
import {
  db,
  novaluthProfilesTable,
  novaluthVisioAppointmentsTable,
  type NovaluthVisioAppointment,
} from "@workspace/db";
import {
  enqueueNovaLuthEmail,
  type NovaLuthDbExecutor,
} from "./novaluth-email-outbox";
import { getNovaLuthPublicUrl } from "./novaluth-email";
import { logger } from "./logger";

export const visioPurposeLabels = {
  projet: "Rendez-vous projet, avant devis",
  bois: "Validation des bois",
  assemblage: "Validation du corps et du manche",
  finition: "Validation de la couleur et de la finition",
  final: "Présentation de l’instrument terminé",
  autre: "Échange libre",
} as const;

export const VISIO_VALIDITY_DAYS = 30;
const VISIO_MODE = (process.env.NOVALUTH_VISIO ?? "jaas").trim().toLowerCase();
const JITSI_DOMAIN =
  process.env.NOVALUTH_JITSI_DOMAIN ??
  process.env.NOVALUTH_JITSI_DOMAINE ??
  "meet.jit.si";
const JAAS_DOMAIN = (process.env.JAAS_DOMAIN ?? "8x8.vc").replace(
  /^https?:\/\//,
  "",
).replace(/\/+$/, "");
const JAAS_APP_ID = process.env.JAAS_APP_ID?.trim() ?? "";
const JAAS_API_KEY_ID = process.env.JAAS_API_KEY_ID?.trim() ?? "";
const JAAS_PRIVATE_KEY = (
  process.env.JAAS_PRIVATE_KEY ??
  process.env.JAAS_CLE_PRIVEE ??
  ""
).trim();
const JAAS_TOKEN_VALIDITY_HOURS = 3;

type VisioProvider = "jaas" | "jitsi";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return randomBytes(32).toString("base64url");
}

function createRoomName() {
  return `novaluth-${randomBytes(24).toString("base64url")}`;
}

function createReference() {
  return `VIS-${randomBytes(7).toString("hex").toUpperCase()}`;
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function jaasIsConfigured() {
  return Boolean(JAAS_APP_ID && JAAS_API_KEY_ID && JAAS_PRIVATE_KEY);
}

function createJaasJwt({
  roomName,
  displayName,
  email,
  moderator,
}: {
  roomName: string;
  displayName: string;
  email: string;
  moderator: boolean;
}) {
  if (VISIO_MODE === "public" || !jaasIsConfigured()) return null;

  try {
    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: "RS256",
      kid: JAAS_API_KEY_ID,
      typ: "JWT",
    };
    const payload = {
      aud: "jitsi",
      iss: "chat",
      sub: JAAS_APP_ID,
      room: roomName,
      nbf: now - 5 * 60,
      exp: now + JAAS_TOKEN_VALIDITY_HOURS * 60 * 60,
      context: {
        user: {
          id: randomBytes(16).toString("hex"),
          name: displayName,
          email,
          moderator: moderator ? "true" : "false",
          "hidden-from-recorder": "false",
        },
        features: {
          recording: false,
          livestreaming: false,
          transcription: false,
          "sip-inbound-call": false,
          "sip-outbound-call": false,
          "inbound-call": false,
          "outbound-call": false,
          "file-upload": false,
        },
        room: { regex: false },
      },
    };
    const encodedHeader = base64Url(JSON.stringify(header));
    const encodedPayload = base64Url(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const privateKey = createPrivateKey(JAAS_PRIVATE_KEY.replace(/\\n/g, "\n"));
    const signature = signer.sign(privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : "unknown signing error" },
      "JaaS JWT signing failed; falling back to public Jitsi",
    );
    return null;
  }
}

function visioAccess({
  roomName,
  role,
  atelierName,
  atelierEmail,
  musicianEmail,
}: {
  roomName: string;
  role: "atelier" | "musicien";
  atelierName: string;
  atelierEmail: string;
  musicianEmail: string;
}): {
  provider: VisioProvider;
  domain: string;
  roomName: string;
  jwt: string | null;
  fallbackDomain: string;
  fallbackRoomName: string;
} {
  const isAtelier = role === "atelier";
  const jwt = createJaasJwt({
    roomName,
    displayName: isAtelier ? atelierName : "Musicien",
    email: isAtelier ? atelierEmail : musicianEmail,
    moderator: isAtelier,
  });

  if (jwt) {
    return {
      provider: "jaas",
      domain: JAAS_DOMAIN,
      roomName: `${JAAS_APP_ID}/${roomName}`,
      jwt,
      fallbackDomain: JITSI_DOMAIN,
      fallbackRoomName: roomName,
    };
  }

  return {
    provider: "jitsi",
    domain: JITSI_DOMAIN,
    roomName,
    jwt: null,
    fallbackDomain: JITSI_DOMAIN,
    fallbackRoomName: roomName,
  };
}

function appointmentStatus(appointment: NovaluthVisioAppointment, now = new Date()) {
  if (appointment.cancelledAt) return "annulee" as const;
  if (appointment.expiresAt <= now) return "expiree" as const;
  return "active" as const;
}

function appointmentPath(token: string) {
  return `/visio/${token}`;
}

async function atelierName(slug: string) {
  const [atelier] = await db
    .select({ name: novaluthProfilesTable.name })
    .from(novaluthProfilesTable)
    .where(eq(novaluthProfilesTable.slug, slug));
  return atelier?.name ?? slug;
}

export function visioAppointmentView(
  appointment: NovaluthVisioAppointment,
  name: string,
  atelierToken?: string | null,
) {
  return {
    id: appointment.id,
    reference: appointment.reference,
    atelier_slug: appointment.atelierSlug,
    atelier_nom: name,
    email_musicien: appointment.musicianEmail,
    objet: appointment.purpose,
    objet_libelle:
      visioPurposeLabels[appointment.purpose as keyof typeof visioPurposeLabels] ??
      appointment.purpose,
    date_heure: appointment.scheduledAt?.toISOString() ?? null,
    expire_le: appointment.expiresAt.toISOString(),
    statut: appointmentStatus(appointment),
    lien_atelier: atelierToken ? appointmentPath(atelierToken) : null,
  };
}

export async function listVisioAppointmentsForAtelier(slug: string) {
  const [name, appointments] = await Promise.all([
    atelierName(slug),
    db
      .select()
      .from(novaluthVisioAppointmentsTable)
      .where(eq(novaluthVisioAppointmentsTable.atelierSlug, slug))
      .orderBy(desc(novaluthVisioAppointmentsTable.createdAt))
      .limit(50),
  ]);
  return appointments.map((appointment) =>
    visioAppointmentView(appointment, name),
  );
}

export async function createVisioAppointment(
  slug: string,
  input: {
    email_musicien: string;
    email_atelier: string;
    objet: string;
    date_heure?: Date | null;
    reference_projet?: string | null;
    commande_id?: number | null;
  },
) {
  const musicianToken = createToken();
  const atelierToken = createToken();
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + VISIO_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
  );
  const reference = createReference();
  const scheduledAt = input.date_heure ?? null;

  const created = await db.transaction(async (tx) => {
    const [appointment] = await tx
      .insert(novaluthVisioAppointmentsTable)
      .values({
        reference,
        atelierSlug: slug,
        projectReference: input.reference_projet ?? null,
        orderId: input.commande_id ?? null,
        atelierEmail: input.email_atelier.trim().toLowerCase(),
        musicianEmail: input.email_musicien.trim().toLowerCase(),
        purpose: input.objet,
        roomName: createRoomName(),
        atelierTokenHash: hashToken(atelierToken),
        musicianTokenHash: hashToken(musicianToken),
        scheduledAt,
        expiresAt,
      })
      .returning();

    const publicUrl = getNovaLuthPublicUrl();
    let emailQueued = false;
    if (publicUrl) {
      const [atelier] = await Promise.all([
        tx
          .select({ name: novaluthProfilesTable.name })
          .from(novaluthProfilesTable)
          .where(eq(novaluthProfilesTable.slug, slug)),
      ]);
      const details = {
        event: "video_invitation" as const,
        reference,
        atelierName: atelier[0]?.name ?? slug,
        meetingAt: scheduledAt,
        meetingPurpose:
          visioPurposeLabels[input.objet as keyof typeof visioPurposeLabels] ??
          input.objet,
        accessEndsAt: expiresAt,
        portalUrl: `${publicUrl}${appointmentPath(musicianToken)}`,
      };
      const musicianEmail = await enqueueNovaLuthEmail(
        tx as NovaLuthDbExecutor,
        input.email_musicien.trim().toLowerCase(),
        {
          ...details,
          actionUrl: `${publicUrl}${appointmentPath(musicianToken)}`,
          actionLabel: "Ouvrir mon rendez-vous",
        },
        `video_invitation:${reference}:musicien`,
      );
      const atelierEmail = await enqueueNovaLuthEmail(
        tx as NovaLuthDbExecutor,
        input.email_atelier.trim().toLowerCase(),
        {
          ...details,
          portalUrl: `${publicUrl}${appointmentPath(atelierToken)}`,
          actionUrl: `${publicUrl}${appointmentPath(atelierToken)}`,
          actionLabel: "Ouvrir mon rendez-vous",
        },
        `video_invitation:${reference}:atelier`,
      );
      emailQueued = musicianEmail.queued || atelierEmail.queued;
    }
    return { appointment, emailQueued };
  });

  const name = await atelierName(slug);
  return {
    appointment: visioAppointmentView(created.appointment, name, atelierToken),
    musicianToken,
    musicianPath: appointmentPath(musicianToken),
    atelierPath: appointmentPath(atelierToken),
    emailQueued: created.emailQueued,
  };
}

export async function getVisioAppointmentByToken(token: string) {
  const tokenHash = hashToken(token);
  const [appointment] = await db
    .select()
    .from(novaluthVisioAppointmentsTable)
    .where(
      or(
        eq(novaluthVisioAppointmentsTable.atelierTokenHash, tokenHash),
        eq(novaluthVisioAppointmentsTable.musicianTokenHash, tokenHash),
      ),
    );
  if (!appointment || appointmentStatus(appointment) !== "active") return null;

  const role =
    appointment.atelierTokenHash === tokenHash ? ("atelier" as const) : ("musicien" as const);
  const atelierNameValue = await atelierName(appointment.atelierSlug);
  const access = visioAccess({
    roomName: appointment.roomName,
    role,
    atelierName: atelierNameValue,
    atelierEmail: appointment.atelierEmail,
    musicianEmail: appointment.musicianEmail,
  });
  await db
    .update(novaluthVisioAppointmentsTable)
    .set({ [role === "atelier" ? "atelierJoinedAt" : "musicianJoinedAt"]: new Date() })
    .where(eq(novaluthVisioAppointmentsTable.id, appointment.id));

  return {
    reference: appointment.reference,
    role,
    atelierName: atelierNameValue,
    purpose: appointment.purpose,
    purposeLabel:
      visioPurposeLabels[appointment.purpose as keyof typeof visioPurposeLabels] ??
      appointment.purpose,
    scheduledAt: appointment.scheduledAt,
    expiresAt: appointment.expiresAt,
    provider: access.provider,
    jitsiDomain: access.domain,
    roomName: access.roomName,
    jwt: access.jwt,
    fallbackDomain: access.fallbackDomain,
    fallbackRoomName: access.fallbackRoomName,
  };
}

export async function cancelVisioAppointment(slug: string, reference: string) {
  const [updated] = await db
    .update(novaluthVisioAppointmentsTable)
    .set({ cancelledAt: new Date() })
    .where(
      and(
        eq(novaluthVisioAppointmentsTable.atelierSlug, slug),
        eq(novaluthVisioAppointmentsTable.reference, reference),
        isNull(novaluthVisioAppointmentsTable.cancelledAt),
      ),
    )
    .returning();
  if (!updated) return null;
  return visioAppointmentView(updated, await atelierName(slug));
}

export async function rotateAtelierVisioToken(slug: string, reference: string) {
  const token = createToken();
  const [updated] = await db
    .update(novaluthVisioAppointmentsTable)
    .set({ atelierTokenHash: hashToken(token) })
    .where(
      and(
        eq(novaluthVisioAppointmentsTable.atelierSlug, slug),
        eq(novaluthVisioAppointmentsTable.reference, reference),
        isNull(novaluthVisioAppointmentsTable.cancelledAt),
        gt(novaluthVisioAppointmentsTable.expiresAt, new Date()),
      ),
    )
    .returning();
  return updated ? { lien_atelier: appointmentPath(token) } : null;
}

export async function runVisioMaintenance(now = new Date()) {
  const reminderLimit = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const candidates = await db
    .select()
    .from(novaluthVisioAppointmentsTable)
    .where(
      and(
        isNull(novaluthVisioAppointmentsTable.cancelledAt),
        isNull(novaluthVisioAppointmentsTable.reminderSentAt),
        gt(novaluthVisioAppointmentsTable.scheduledAt, now),
        lte(novaluthVisioAppointmentsTable.scheduledAt, reminderLimit),
        gt(novaluthVisioAppointmentsTable.expiresAt, now),
      ),
    );
  const publicUrl = getNovaLuthPublicUrl();
  if (!publicUrl) return { reminders: 0 };

  let reminders = 0;
  for (const candidate of candidates) {
    const reminded = await db.transaction(async (tx) => {
      const musicianToken = createToken();
      const atelierToken = createToken();
      const [updated] = await tx
        .update(novaluthVisioAppointmentsTable)
        .set({
          musicianTokenHash: hashToken(musicianToken),
          atelierTokenHash: hashToken(atelierToken),
          reminderSentAt: now,
        })
        .where(
          and(
            eq(novaluthVisioAppointmentsTable.id, candidate.id),
            isNull(novaluthVisioAppointmentsTable.reminderSentAt),
          ),
        )
        .returning();
      if (!updated) return false;

      const [atelier] = await tx
        .select({ name: novaluthProfilesTable.name })
        .from(novaluthProfilesTable)
        .where(eq(novaluthProfilesTable.slug, updated.atelierSlug));
      const details = {
        event: "video_invitation" as const,
        reference: updated.reference,
        atelierName: atelier?.name ?? updated.atelierSlug,
        meetingAt: updated.scheduledAt,
        meetingPurpose:
          visioPurposeLabels[updated.purpose as keyof typeof visioPurposeLabels] ??
          updated.purpose,
        accessEndsAt: updated.expiresAt,
        portalUrl: `${publicUrl}${appointmentPath(musicianToken)}`,
      };
      await enqueueNovaLuthEmail(
        tx as NovaLuthDbExecutor,
        updated.musicianEmail,
        {
          ...details,
          actionUrl: `${publicUrl}${appointmentPath(musicianToken)}`,
          actionLabel: "Ouvrir mon rendez-vous",
        },
        `video_invitation:${updated.reference}:reminder:musicien`,
      );
      await enqueueNovaLuthEmail(
        tx as NovaLuthDbExecutor,
        updated.atelierEmail,
        {
          ...details,
          portalUrl: `${publicUrl}${appointmentPath(atelierToken)}`,
          actionUrl: `${publicUrl}${appointmentPath(atelierToken)}`,
          actionLabel: "Ouvrir mon rendez-vous",
        },
        `video_invitation:${updated.reference}:reminder:atelier`,
      );
      return true;
    });
    if (reminded) reminders += 1;
  }
  return { reminders };
}