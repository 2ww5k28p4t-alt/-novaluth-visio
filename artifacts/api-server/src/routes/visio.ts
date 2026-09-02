import { and, eq, gt } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CancelVisioAppointmentBody,
  CancelVisioAppointmentParams,
  CancelVisioAppointmentResponse,
  CreateVisioAppointmentBody,
  CreateVisioAppointmentParams,
  CreateVisioAppointmentResponse,
  GetVisioRoomParams,
  GetVisioRoomResponse,
  ListVisioAppointmentsParams,
  ListVisioAppointmentsResponse,
  RotateVisioAtelierLinkBody,
  RotateVisioAtelierLinkParams,
  RotateVisioAtelierLinkResponse,
} from "@workspace/api-zod";
import {
  db,
  novaluthAtelierSessionsTable,
  novaluthProfilesTable,
  novaluthProjectsTable,
  novaluthProtectedOrdersTable,
} from "@workspace/db";
import {
  cancelVisioAppointment,
  createVisioAppointment,
  getVisioAppointmentByToken,
  listVisioAppointmentsForAtelier,
  rotateAtelierVisioToken,
} from "../lib/novaluth-visio";

const router: IRouter = Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requireAtelierSession(slug: string, token: string | undefined) {
  if (!token) return null;
  const [session] = await db
    .select()
    .from(novaluthAtelierSessionsTable)
    .where(
      and(
        eq(novaluthAtelierSessionsTable.token, token),
        eq(novaluthAtelierSessionsTable.atelierSlug, slug),
        gt(novaluthAtelierSessionsTable.expiresAt, new Date()),
      ),
    );
  if (!session) return null;
  await db
    .update(novaluthAtelierSessionsTable)
    .set({ lastSeenAt: new Date() })
    .where(eq(novaluthAtelierSessionsTable.token, token));
  return session;
}

router.get("/ateliers/:slug/visio", async (req, res, next): Promise<void> => {
  try {
    const { slug } = ListVisioAppointmentsParams.parse(req.params);
    if (
      !(await requireAtelierSession(
        slug,
        req.header("X-NovaLuth-Atelier-Session") ?? undefined,
      ))
    ) {
      res.status(401).json({ error: "Session atelier invalide ou expirée." });
      return;
    }
    res.json(
      ListVisioAppointmentsResponse.parse(
        await listVisioAppointmentsForAtelier(slug),
      ),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/ateliers/:slug/visio", async (req, res, next): Promise<void> => {
  try {
    const { slug } = CreateVisioAppointmentParams.parse(req.params);
    const input = CreateVisioAppointmentBody.parse(req.body);
    if (
      !emailPattern.test(input.email_musicien) ||
      !emailPattern.test(input.email_atelier)
    ) {
      res.status(400).json({ error: "Les deux adresses e-mail doivent être valides." });
      return;
    }
    if (!(await requireAtelierSession(slug, input.session))) {
      res.status(401).json({ error: "Session atelier invalide ou expirée." });
      return;
    }
    if (input.date_heure && input.date_heure <= new Date()) {
      res.status(400).json({ error: "La date du rendez-vous doit être future." });
      return;
    }
    if (input.reference_projet) {
      const [project] = await db
        .select({ reference: novaluthProjectsTable.reference })
        .from(novaluthProjectsTable)
        .where(eq(novaluthProjectsTable.reference, input.reference_projet));
      if (!project) {
        res.status(400).json({ error: "Projet NovaLuth introuvable." });
        return;
      }
    }
    if (input.commande_id) {
      const [order] = await db
        .select({ id: novaluthProtectedOrdersTable.id })
        .from(novaluthProtectedOrdersTable)
        .where(eq(novaluthProtectedOrdersTable.id, input.commande_id));
      if (!order) {
        res.status(400).json({ error: "Commande protégée introuvable." });
        return;
      }
    }
    const created = await createVisioAppointment(slug, input);
    res.status(201).json(
      CreateVisioAppointmentResponse.parse({
        rendez_vous: created.appointment,
        lien_musicien: created.musicianPath,
        courriel_envoye: created.emailQueued,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post(
  "/ateliers/:slug/visio/:reference/annulation",
  async (req, res, next): Promise<void> => {
    try {
      const { slug, reference } = CancelVisioAppointmentParams.parse(req.params);
      const { session } = CancelVisioAppointmentBody.parse(req.body);
      if (!(await requireAtelierSession(slug, session))) {
        res.status(401).json({ error: "Session atelier invalide ou expirée." });
        return;
      }
      const cancelled = await cancelVisioAppointment(slug, reference);
      if (!cancelled) {
        res.status(404).json({ error: "Rendez-vous introuvable ou déjà annulé." });
        return;
      }
      res.json(CancelVisioAppointmentResponse.parse(cancelled));
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/ateliers/:slug/visio/:reference/lien-atelier",
  async (req, res, next): Promise<void> => {
    try {
      const { slug, reference } = RotateVisioAtelierLinkParams.parse(req.params);
      const { session } = RotateVisioAtelierLinkBody.parse(req.body);
      if (!(await requireAtelierSession(slug, session))) {
        res.status(401).json({ error: "Session atelier invalide ou expirée." });
        return;
      }
      const link = await rotateAtelierVisioToken(slug, reference);
      if (!link) {
        res.status(404).json({ error: "Rendez-vous introuvable, annulé ou expiré." });
        return;
      }
      res.json(RotateVisioAtelierLinkResponse.parse(link));
    } catch (error) {
      next(error);
    }
  },
);

router.get("/visio/:token", async (req, res, next): Promise<void> => {
  try {
    const { token } = GetVisioRoomParams.parse(req.params);
    const room = await getVisioAppointmentByToken(token);
    if (!room) {
      res.status(404).json({ error: "Ce lien de visioconférence est invalide ou expiré." });
      return;
    }
    res.json(
      GetVisioRoomResponse.parse({
        reference: room.reference,
        role: room.role,
        atelier_nom: room.atelierName,
        objet: room.purpose,
        objet_libelle: room.purposeLabel,
        date_heure: room.scheduledAt?.toISOString() ?? null,
        expire_le: room.expiresAt.toISOString(),
        mode_visio: room.provider,
        domaine_jitsi: room.jitsiDomain,
        nom_salle: room.roomName,
        jeton_jwt: room.jwt,
        domaine_jitsi_secours: room.fallbackDomain,
        nom_salle_secours: room.fallbackRoomName,
      }),
    );
  } catch (error) {
    next(error);
  }
});

export default router;