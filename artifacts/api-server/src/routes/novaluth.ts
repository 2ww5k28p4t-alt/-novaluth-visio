import { and, eq, gt, gte, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  CreateBriefBody,
  CreateBriefResponse,
  CreateAtelierAccessRequestBody,
  CreateAtelierAccessRequestParams,
  CreateAtelierAccessRequestResponse,
  CancelAtelierAccessRequestBody,
  CancelAtelierAccessRequestParams,
  CancelAtelierAccessRequestResponse,
  DecideMusicianAccessRequestBody,
  DecideMusicianAccessRequestParams,
  DecideMusicianAccessRequestResponse,
  GetAtelierDashboardParams,
  GetAtelierDashboardResponse,
  GetAdminSummaryResponse,
  GetFicheParams,
  GetFicheResponse,
  GetFichesMetaResponse,
  GetMusicianProjectParams,
  GetMusicianProjectResponse,
  ListFichesQueryParams,
  ListFichesResponse,
  ListAtelierProjectsParams,
  ListAtelierProjectsResponse,
  OpenAtelierSessionBody,
  OpenAtelierSessionParams,
  OpenAtelierSessionResponse,
  RecommendBody,
  RecommendResponse,
  RunAccessMaintenanceResponse,
  UpdateFicheStatusBody,
  UpdateFicheStatusParams,
  UpdateFicheStatusResponse,
  UseAtelierFollowupCreditBody,
  UseAtelierFollowupCreditParams,
  UseAtelierFollowupCreditResponse,
} from "@workspace/api-zod";
import {
  db,
  novaluthAccessRequestsTable,
  novaluthAtelierSessionsTable,
  novaluthBriefsTable,
  novaluthProfilesTable,
  novaluthProjectsTable,
  type NovaluthAccessRequest,
  type NovaluthProject,
} from "@workspace/db";
import { novaluthSeed } from "../data/novaluth-seed";
import {
  availableFacetFamilies,
  availableStyles,
  facetLabel,
  facetProvenance,
  facetsForFiche,
  filterDirectory,
  normalizeFacetKeys,
  sortDirectory,
  type DirectorySort,
} from "../lib/novaluth-facets";
import { availableSoundColours, compareSound, soundFromLegacy } from "../lib/novaluth-sound";
import {
  getNovaLuthPublicUrl,
  isNovaLuthEmailConfigured,
  type NovaLuthEmailEvent,
} from "../lib/novaluth-email";
import {
  enqueueNovaLuthEmail,
  getNovaLuthEmailOutboxSummary,
  type NovaLuthDbExecutor,
} from "../lib/novaluth-email-outbox";
import {
  novaLuthTelegramTestMessage,
  NovaLuthTelegramError,
  sendNovaLuthTelegramMessage,
} from "../lib/novaluth-telegram";
import { logger } from "../lib/logger";
import { lastSn13Call } from "../gateway/provider-registry";

const router: IRouter = Router();
const publicStatus = "publiee";
const statuses = [
  "candidate",
  "a_verifier",
  "a_suivre",
  "trop_etablie",
  "rejetee",
  "publiee",
] as const;
const accessPlans = {
  essentiel: { amountCents: 999, followupCredits: 1 },
  atelier: { amountCents: 1599, followupCredits: 2 },
  signature: { amountCents: 2499, followupCredits: 3 },
} as const;
const activeRequestStatuses = ["en_attente", "acceptee"] as const;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

type Fiche = ReturnType<typeof GetFicheResponse.parse>;
type Brief = {
  type_instrument: string;
  budget_min_eur: number;
  budget_max_eur: number;
  styles: string[];
  bois_souhaites: string[];
  delai_max_mois?: number | null;
  pays_livraison?: string | null;
  zone_preferee: string;
  couleur_souhaitee?: string | null;
  attaque_souhaitee?: string | null;
  tenue_souhaitee?: string | null;
  facons_recherchees?: string[];
  personnalisation: boolean;
  description_libre: string;
  email?: string | null;
  consentement_transmission?: boolean;
};

let seeded: Promise<void> | undefined;

function seedProfiles(): Promise<void> {
  seeded ??= (async () => {
    await db
      .insert(novaluthProfilesTable)
      .values(
        novaluthSeed.map((fiche) => ({
        slug: fiche.slug,
        name: fiche.nom,
        entityType: fiche.type,
        country: fiche.pays,
        city: fiche.ville,
        status: fiche.statut,
        innovationScore: fiche.innovation.niveau ?? fiche.score_innovation,
        minimumPriceEur: fiche.prix_min_eur,
        maximumPriceEur: fiche.prix_max_eur,
        data: fiche,
        isDemo: fiche.demonstration,
        })),
      )
      .onConflictDoNothing();
  })();
  return seeded;
}

function getFiche(data: unknown): Fiche {
  const raw = data as Record<string, unknown>;
  const manualSource = Array.isArray(raw.source_donnees) && raw.source_donnees.includes("saisie manuelle");
  const storedSound = raw.profil_sonore && typeof raw.profil_sonore === "object"
    ? raw.profil_sonore as Record<string, unknown>
    : {};
  const demonstrationSource = raw.demonstration
    ? novaluthSeed.find((fiche) => fiche.slug === raw.slug)?.profil_sonore
    : undefined;
  const rawSound = soundFromLegacy({
    ...storedSound,
    couleur: storedSound.couleur ?? demonstrationSource?.couleur,
    attaque: storedSound.attaque ?? demonstrationSource?.attaque,
    tenue: storedSound.tenue ?? demonstrationSource?.tenue,
  });
  const core = GetFicheResponse.parse({
    ...raw,
    profil_sonore: rawSound,
    facons_travail: [],
    provenance_facons: "d’après ses pages publiques",
  });
  return {
    ...core,
    facons_travail: facetsForFiche(core),
    provenance_facons: manualSource ? "saisie manuelle" : facetProvenance(core),
  };
}

function normalized(values: readonly string[]) {
  return values.map((value) => value.trim().toLocaleLowerCase("fr")).filter(Boolean);
}

function overlap(wanted: readonly string[], available: readonly string[]) {
  const requested = normalized(wanted);
  const possibilities = normalized(available);
  if (!requested.length) return 0;
  return requested.filter((value) =>
    possibilities.some((candidate) => candidate.includes(value) || value.includes(candidate)),
  ).length / requested.length;
}

function evaluateMatch(brief: Brief, fiche: Fiche) {
  let score = 0;
  const points: string[] = [];
  const warnings: string[] = [];
  const priceMin = fiche.prix_min_eur ?? 0;
  const priceMax = fiche.prix_max_eur ?? Number.MAX_SAFE_INTEGER;

  if (brief.budget_max_eur >= priceMin && brief.budget_min_eur <= priceMax) {
    score += 26;
    points.push("La fourchette tarifaire recoupe votre budget.");
  } else {
    warnings.push("Tarif annoncé hors de votre fourchette.");
  }

  const matchingModels = fiche.modeles.filter(
    (model) => model.type === brief.type_instrument,
  );
  if (matchingModels.length) {
    score += 14;
    points.push("Un modèle correspondant à votre type d’instrument est documenté.");
  } else {
    warnings.push("Le type d’instrument demandé n’est pas documenté.");
  }

  const styleScore = overlap(brief.styles, fiche.profil_sonore.styles ?? []);
  if (styleScore) {
    score += Math.round(14 * styleScore);
    points.push("Les styles décrits se rapprochent du profil sonore annoncé.");
  }

  if (brief.delai_max_mois != null && fiche.delai_moyen_mois != null) {
    if (fiche.delai_moyen_mois <= brief.delai_max_mois) {
      score += 10;
      points.push("Le délai annoncé respecte votre échéance.");
    } else {
      warnings.push(`Délai moyen annoncé de ${fiche.delai_moyen_mois} mois, au-delà de votre limite.`);
    }
  }

  const woods = fiche.modeles.flatMap((model) =>
    [
      model.specifications.bois_corps,
      model.specifications.bois_manche,
      model.specifications.touche,
    ]
      .filter((value) => value !== null && value !== undefined)
      .map((value) => String(value)),
  );
  const woodScore = overlap(brief.bois_souhaites, woods);
  if (woodScore) {
    score += Math.round(8 * woodScore);
    points.push("Des essences de bois demandées sont documentées.");
  }

  const soundMatch = compareSound(fiche.profil_sonore, {
    couleur: brief.couleur_souhaitee,
    attaque: brief.attaque_souhaitee,
    tenue: brief.tenue_souhaitee,
  });
  if (soundMatch.proximity != null) {
    score += Math.round(8 * soundMatch.proximity);
    points.push(...soundMatch.points);
    warnings.push(...soundMatch.warnings);
  }

  const soughtFacets = normalizeFacetKeys(brief.facons_recherchees ?? []);
  if (soughtFacets.length) {
    const documented = new Set(fiche.facons_travail);
    const shared = soughtFacets.filter((facet) => documented.has(facet));
    score += Math.round(8 * shared.length / soughtFacets.length);
    if (shared.length) {
      points.push(`Correspond à ce que vous cherchez : ${shared.map(facetLabel).join(", ").toLocaleLowerCase("fr")}.`);
    }
    const missing = soughtFacets.filter((facet) => !documented.has(facet));
    if (missing.length) {
      warnings.push(`Non documenté chez cet atelier : ${missing.map(facetLabel).join(", ").toLocaleLowerCase("fr")}.`);
    }
  } else if (fiche.facons_travail.length) {
    score += 5;
    points.push(`Manière de travailler documentée : ${fiche.facons_travail.slice(0, 3).map(facetLabel).join(", ").toLocaleLowerCase("fr")}.`);
  }

  if (brief.personnalisation) {
    if (fiche.modeles.some((model) => model.personnalisable)) {
      score += 4;
      points.push("La personnalisation est proposée sur au moins un modèle.");
    } else {
      warnings.push("La personnalisation n’est pas documentée.");
    }
  }

  if (!fiche.valide_par_artisan) {
    warnings.push("Fiche à confirmer directement auprès de l’artisan.");
  }
  if (fiche.demonstration) {
    warnings.push("Fiche de démonstration, présente pour illustrer le service.");
  }

  return {
    slug: fiche.slug,
    nom: fiche.nom,
    type: fiche.type,
    ville: fiche.ville,
    pays: fiche.pays,
    prix_min_eur: fiche.prix_min_eur,
    prix_max_eur: fiche.prix_max_eur,
    delai_moyen_mois: fiche.delai_moyen_mois,
    site_web: fiche.site_web,
    demonstration: fiche.demonstration,
    valide_par_artisan: fiche.valide_par_artisan,
    correspondance: Math.min(100, Math.round(score)),
    points_correspondance: points,
    points_vigilance: warnings,
  };
}

async function recommendations(brief: Brief) {
  await seedProfiles();
  const soughtFacets = normalizeFacetKeys(brief.facons_recherchees ?? []);
  const rows = await db
    .select()
    .from(novaluthProfilesTable)
    .where(eq(novaluthProfilesTable.status, publicStatus));
  return rows
    .map((row) => getFiche(row.data))
    .filter((fiche) => soughtFacets.every((facet) => fiche.facons_travail.includes(facet)))
    .map((fiche) => evaluateMatch(brief, fiche))
    .filter((result) => result.correspondance > 0)
    .sort((left, right) => right.correspondance - left.correspondance)
    .slice(0, 3);
}

function requireAdminToken(token: string | undefined) {
  const expected = process.env.NOVALUTH_ADMIN_TOKEN ?? "demo-admin";
  return token === expected;
}

function portalPath(reference: string, musicianToken: string) {
  return `/projets/${reference}/portail/${musicianToken}`;
}

function portalUrl(path: string) {
  const publicUrl = getNovaLuthPublicUrl();
  return publicUrl ? `${publicUrl}${path}` : null;
}

async function notifyProjectEmail(
  project: Pick<NovaluthProject, "email" | "reference" | "musicianToken">,
  event: NovaLuthEmailEvent,
  details: { atelierName?: string; plan?: string; accessEndsAt?: Date | null } = {},
  executor: NovaLuthDbExecutor = db,
  dedupeKey = `${event}:${project.reference}`,
) {
  const privatePortalUrl = portalUrl(portalPath(project.reference, project.musicianToken));
  if (!privatePortalUrl) {
    logger.warn(
      { event, reference: project.reference },
      "NovaLuth email not sent: NOVALUTH_PUBLIC_URL must be a valid HTTPS URL",
    );
    return { sent: false as const, reason: "not_configured" as const };
  }

  const queued = await enqueueNovaLuthEmail(
    executor,
    project.email,
    {
      event,
      reference: project.reference,
      portalUrl: privatePortalUrl,
      ...details,
    },
    dedupeKey,
  );
  return queued.queued
    ? { sent: true as const, deduplicated: queued.deduplicated }
    : { sent: false as const, reason: queued.reason };
}

function projectForAtelier(project: NovaluthProject, includeDescription = false) {
  const criteria = project.criteria as Brief;
  return {
    reference: project.reference,
    type_instrument: criteria.type_instrument,
    budget_min_eur: criteria.budget_min_eur,
    budget_max_eur: criteria.budget_max_eur,
    styles: criteria.styles,
    description: includeDescription ? criteria.description_libre : null,
    cree_le: project.createdAt.toISOString(),
  };
}

async function requestForDisplay(
  request: NovaluthAccessRequest,
  includeProjectDescription = false,
) {
  const [[atelier], [project]] = await Promise.all([
    db
      .select()
      .from(novaluthProfilesTable)
      .where(eq(novaluthProfilesTable.slug, request.atelierSlug)),
    db
      .select()
      .from(novaluthProjectsTable)
      .where(eq(novaluthProjectsTable.reference, request.projectReference)),
  ]);
  return {
    id: request.id,
    reference_projet: request.projectReference,
    atelier_slug: request.atelierSlug,
    atelier_nom: atelier ? getFiche(atelier.data).nom : request.atelierSlug,
    offre: request.plan,
    montant_eur: request.amountCents / 100,
    statut: request.status,
    statut_paiement: request.paymentStatus,
    cree_le: request.requestedAt.toISOString(),
    decide_le: request.decidedAt?.toISOString() ?? null,
    expire_le: request.accessEndsAt?.toISOString() ?? null,
    credits_relance: request.followupCredits,
    derniere_relance_le: request.lastFollowupAt?.toISOString() ?? null,
    projet: project ? projectForAtelier(project, includeProjectDescription) : undefined,
  };
}

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

export async function runMaintenance(trigger: "request" | "scheduled" = "request") {
  const now = new Date();
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const inTwoDays = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  let annulations = 0;
  let expirations = 0;
  let relances = 0;
  let projetsSommeil = 0;

  const pendingToCancel = await db
    .select()
    .from(novaluthAccessRequestsTable)
    .where(
      and(
        eq(novaluthAccessRequestsTable.status, "en_attente"),
        lte(novaluthAccessRequestsTable.requestedAt, fiveDaysAgo),
      ),
    );
  for (const request of pendingToCancel) {
    const cancelled = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(novaluthAccessRequestsTable)
        .set({ status: "annulee", paymentStatus: "annule", decidedAt: now })
        .where(
          and(
            eq(novaluthAccessRequestsTable.id, request.id),
            eq(novaluthAccessRequestsTable.status, "en_attente"),
          ),
        )
        .returning();
      if (!updated) return false;
      const [project] = await tx
        .select()
        .from(novaluthProjectsTable)
        .where(eq(novaluthProjectsTable.reference, updated.projectReference));
      if (project) {
        await notifyProjectEmail(
          project,
          "request_cancelled",
          { plan: updated.plan },
          tx,
          `request_cancelled:${updated.id}`,
        );
      }
      return true;
    });
    if (cancelled) annulations += 1;
  }

  const acceptedToExpire = await db
    .select()
    .from(novaluthAccessRequestsTable)
    .where(
      and(
        eq(novaluthAccessRequestsTable.status, "acceptee"),
        lte(novaluthAccessRequestsTable.accessEndsAt, now),
      ),
    );
  for (const request of acceptedToExpire) {
    const expired = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(novaluthAccessRequestsTable)
        .set({ status: "expiree" })
        .where(
          and(
            eq(novaluthAccessRequestsTable.id, request.id),
            eq(novaluthAccessRequestsTable.status, "acceptee"),
          ),
        )
        .returning();
      if (!updated) return false;
      const [project] = await tx
        .select()
        .from(novaluthProjectsTable)
        .where(eq(novaluthProjectsTable.reference, updated.projectReference));
      if (project) {
        await notifyProjectEmail(
          project,
          "request_expired",
          { plan: updated.plan, accessEndsAt: updated.accessEndsAt },
          tx,
          `request_expired:${updated.id}`,
        );
      }
      return true;
    });
    if (expired) expirations += 1;
  }

  const candidatesForReminder = await db
    .select()
    .from(novaluthAccessRequestsTable)
    .where(eq(novaluthAccessRequestsTable.status, "en_attente"));
  for (const request of candidatesForReminder) {
    if (request.requestedAt > threeDaysAgo) continue;
    const queued = await db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(novaluthProjectsTable)
        .where(eq(novaluthProjectsTable.reference, request.projectReference));
      if (!project) return false;
      const result = await notifyProjectEmail(
        project,
        "pending_reminder",
        { plan: request.plan },
        tx,
        `pending_reminder:${request.id}`,
      );
      return result.sent && !result.deduplicated;
    });
    if (queued) relances += 1;
  }

  const accessEndingSoon = await db
    .select()
    .from(novaluthAccessRequestsTable)
    .where(eq(novaluthAccessRequestsTable.status, "acceptee"));
  for (const request of accessEndingSoon) {
    if (!request.accessEndsAt || request.accessEndsAt > inTwoDays) continue;
    const queued = await db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(novaluthProjectsTable)
        .where(eq(novaluthProjectsTable.reference, request.projectReference));
      if (!project) return false;
      const result = await notifyProjectEmail(
        project,
        "access_expiring_soon",
        { plan: request.plan, accessEndsAt: request.accessEndsAt },
        tx,
        `access_expiring_soon:${request.id}`,
      );
      return result.sent && !result.deduplicated;
    });
    if (queued) relances += 1;
  }

  const idleProjects = await db
    .select()
    .from(novaluthProjectsTable)
    .where(
      and(
        eq(novaluthProjectsTable.status, "actif"),
        lte(novaluthProjectsTable.lastActivityAt, fiveDaysAgo),
      ),
    );
  for (const project of idleProjects) {
    const activeRequests = await db
      .select()
      .from(novaluthAccessRequestsTable)
      .where(
        and(
          eq(novaluthAccessRequestsTable.projectReference, project.reference),
          eq(novaluthAccessRequestsTable.status, "en_attente"),
        ),
      );
    if (!activeRequests.length) {
      await db
        .update(novaluthProjectsTable)
        .set({ status: "sommeil", lastActivityAt: now })
        .where(eq(novaluthProjectsTable.reference, project.reference));
      projetsSommeil += 1;
    }
  }

  const result = {
    annulations,
    expirations,
    relances,
    projets_sommeil: projetsSommeil,
    execute_le: now.toISOString(),
  };
  logger.info({ trigger, ...result }, "NovaLuth access maintenance completed");
  return result;
}

export function startNovaLuthMaintenanceScheduler() {
  if (process.env.NOVALUTH_MAINTENANCE_ENABLED === "false") {
    logger.info("NovaLuth scheduled maintenance disabled");
    return () => undefined;
  }

  const configuredInterval = Number(
    process.env.NOVALUTH_MAINTENANCE_INTERVAL_MS ?? DEFAULT_MAINTENANCE_INTERVAL_MS,
  );
  const intervalMs =
    Number.isFinite(configuredInterval) && configuredInterval > 0
      ? configuredInterval
      : DEFAULT_MAINTENANCE_INTERVAL_MS;
  let running = true;
  let inFlight: Promise<void> | undefined;

  const tick = async () => {
    if (!running || inFlight) return;
    inFlight = runMaintenance("scheduled")
      .then(() => undefined)
      .catch((error) => {
        logger.error({ err: error }, "NovaLuth scheduled maintenance failed");
      })
      .finally(() => {
        inFlight = undefined;
      });
    await inFlight;
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  void tick();

  logger.info({ intervalMs }, "NovaLuth scheduled maintenance started");
  return () => {
    running = false;
    clearInterval(timer);
  };
}

router.get("/fiches", async (req, res, next) => {
  try {
    await seedProfiles();
    const parsed = ListFichesQueryParams.parse({
      pays: typeof req.query.pays === "string" ? req.query.pays : undefined,
      type: typeof req.query.type === "string" ? req.query.type : undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      instrument: typeof req.query.instrument === "string" ? req.query.instrument : undefined,
      style: typeof req.query.style === "string" ? req.query.style : undefined,
      zone: typeof req.query.zone === "string" ? req.query.zone : undefined,
      budget_eur: typeof req.query.budget_eur === "string" ? Number(req.query.budget_eur) : undefined,
      delai_max_mois: typeof req.query.delai_max_mois === "string" ? Number(req.query.delai_max_mois) : undefined,
      relue_seulement: typeof req.query.relue_seulement === "string" ? req.query.relue_seulement === "true" : undefined,
      facons: typeof req.query.facons === "string" ? req.query.facons : undefined,
      tri: typeof req.query.tri === "string" ? req.query.tri : undefined,
      statut: typeof req.query.statut === "string" ? req.query.statut : undefined,
    });
    const conditions = [eq(novaluthProfilesTable.status, parsed.statut ?? publicStatus)];
    if (parsed.pays) conditions.push(eq(novaluthProfilesTable.country, parsed.pays));
    if (parsed.type) conditions.push(eq(novaluthProfilesTable.entityType, parsed.type));
    const rows = await db
      .select()
      .from(novaluthProfilesTable)
      .where(and(...conditions));
    const fiches = rows.map((row) => getFiche(row.data));
    const filtered = filterDirectory(fiches, {
      query: parsed.q,
      instrument: parsed.instrument,
      style: parsed.style,
      soundColour: parsed.couleur_son,
      zone: parsed.zone,
      budget: parsed.budget_eur,
      deadline: parsed.delai_max_mois,
      reviewedOnly: parsed.relue_seulement,
      facets: normalizeFacetKeys((parsed.facons ?? "").split(",")),
    });
    res.json(ListFichesResponse.parse(sortDirectory(filtered, (parsed.tri ?? "equitable") as DirectorySort)));
  } catch (error) {
    if (error instanceof NovaLuthTelegramError) {
      res
        .status(error.statusCode && error.statusCode >= 400 ? error.statusCode : 502)
        .json(
          error.telegramResponse ?? {
            ok: false,
            description: error.message,
          },
        );
      return;
    }
    next(error);
  }
});

router.get("/fiches/meta", async (_req, res, next) => {
  try {
    await seedProfiles();
    const rows = await db.select().from(novaluthProfilesTable);
    const published = rows
      .filter((row) => row.status === publicStatus)
      .map((row) => getFiche(row.data));
    const types = Object.fromEntries(
      rows.reduce((summary, row) => {
        summary.set(row.entityType, (summary.get(row.entityType) ?? 0) + 1);
        return summary;
      }, new Map<string, number>()),
    );
    res.json(
      GetFichesMetaResponse.parse({
        total_publiees: published.length,
        total_fiches: rows.length,
        pays: [...new Set(published.flatMap((fiche) => (fiche.pays ? [fiche.pays] : [])))].sort(),
        types,
        styles: availableStyles(published),
        facettes: availableFacetFamilies(published),
        couleurs_son: availableSoundColours(published),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/fiches/:slug", async (req, res, next) => {
  try {
    await seedProfiles();
    const { slug } = GetFicheParams.parse(req.params);
    const [row] = await db
      .select()
      .from(novaluthProfilesTable)
      .where(and(eq(novaluthProfilesTable.slug, slug), eq(novaluthProfilesTable.status, publicStatus)));
    if (!row) {
      res.status(404).json({ error: "Fiche introuvable." });
      return;
    }
    res.json(getFiche(row.data));
  } catch (error) {
    next(error);
  }
});

router.post("/recommend", async (req, res, next) => {
  try {
    const brief = RecommendBody.parse(req.body) as Brief;
    const resultats = await recommendations(brief);
    res.json(
      RecommendResponse.parse({
        resume: resultats.length
          ? "Voici les ateliers et marques dont les informations documentées se rapprochent le plus de votre projet."
          : "Aucune correspondance suffisante n’est documentée pour le moment.",
        origine_resume: "moteur de correspondance NovaLuth",
        resultats,
        avertissement:
          "NovaLuth référence et met en relation. Les informations doivent être confirmées auprès de l’artisan avant toute commande.",
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/briefs", async (req, res, next) => {
  try {
    const brief = CreateBriefBody.parse(req.body) as Brief;
    if (brief.consentement_transmission === true && !brief.email) {
      res.status(400).json({
        error: "Une adresse e-mail est nécessaire pour ouvrir un portail de suivi partagé.",
      });
      return;
    }
    const resultats = await recommendations(brief);
    const created = await db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(novaluthBriefsTable)
        .values({
          criteria: { ...brief, email: undefined },
          email: brief.consentement_transmission ? brief.email ?? null : null,
          consent: Boolean(brief.consentement_transmission),
          recommendations: resultats,
        })
        .returning();
      const musicianToken = saved.consent ? randomUUID() : null;
      if (musicianToken) {
        await tx.insert(novaluthProjectsTable).values({
          reference: saved.reference,
          musicianToken,
          email: saved.email,
          criteria: saved.criteria,
          recommendedAteliers: resultats.map((result) => result.slug),
        });
      }
      const emailDelivery =
        musicianToken && saved.email
          ? await notifyProjectEmail(
              {
                reference: saved.reference,
                musicianToken,
                email: saved.email,
              },
              "portal_created",
              {},
              tx,
              `portal_created:${saved.reference}`,
            )
          : { sent: false as const, reason: "no_recipient" as const };
      return { saved, musicianToken, emailDelivery };
    });
    res.status(201).json(
      CreateBriefResponse.parse({
        reference: created.saved.reference,
        portail_musicien: created.musicianToken
          ? `/projets/${created.saved.reference}/portail/${created.musicianToken}`
          : null,
        courriel_envoye: created.emailDelivery.sent,
        recommandations: resultats,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/admin/summary", async (req, res, next) => {
  try {
    if (!requireAdminToken(req.header("X-Admin-Token") ?? undefined)) {
      res.status(401).json({ error: "Jeton d’administration invalide." });
      return;
    }
    await seedProfiles();
    const [rows, accessRows] = await Promise.all([
      db.select().from(novaluthProfilesTable),
      db.select().from(novaluthAccessRequestsTable),
    ]);
    const compteurs = Object.fromEntries(
      statuses.map((status) => [status, rows.filter((row) => row.status === status).length]),
    );
    res.json(
      GetAdminSummaryResponse.parse({
        compteurs,
        fiches: rows
          .filter((row) => row.status !== "rejetee" && row.status !== "trop_etablie")
          .map((row) => getFiche(row.data)),
        passerelle: "moteur de correspondance local",
        collecte_sn13: await lastSn13Call(),
        acces: {
          en_attente: accessRows.filter((request) => request.status === "en_attente").length,
          acceptees: accessRows.filter((request) => request.status === "acceptee").length,
          expirees: accessRows.filter((request) => request.status === "expiree").length,
          preautorisations: accessRows.filter((request) => request.paymentStatus === "preautorise").length,
          encaissements: accessRows.filter((request) => request.paymentStatus === "encaisse").length,
        },
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/admin/courriels", async (req, res, next) => {
  try {
    if (!requireAdminToken(req.header("X-Admin-Token") ?? undefined)) {
      res.status(401).json({ error: "Jeton d’administration invalide." });
      return;
    }
    const lignes = await getNovaLuthEmailOutboxSummary();
    res.json({
      total: lignes.reduce((sum, ligne) => sum + Number(ligne.count), 0),
      etats: lignes.map((ligne) => ({
        statut: ligne.status,
        nombre: Number(ligne.count),
        plus_ancien: ligne.oldest_created_at?.toISOString() ?? null,
        prochaine_reprise: ligne.next_available_at?.toISOString() ?? null,
      })),
      limite_tentatives: 5,
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/admin/fiches/:slug/status", async (req, res, next) => {
  try {
    if (!requireAdminToken(req.header("X-Admin-Token") ?? undefined)) {
      res.status(401).json({ error: "Jeton d’administration invalide." });
      return;
    }
    const { slug } = UpdateFicheStatusParams.parse(req.params);
    const { statut } = UpdateFicheStatusBody.parse(req.body);
    const [existing] = await db
      .select()
      .from(novaluthProfilesTable)
      .where(eq(novaluthProfilesTable.slug, slug));
    if (!existing) {
      res.status(404).json({ error: "Fiche introuvable." });
      return;
    }
    const profile = getFiche(existing.data);
    const data = { ...profile, statut, maj_le: new Date().toISOString() };
    const [updated] = await db
      .update(novaluthProfilesTable)
      .set({ status: statut, data })
      .where(eq(novaluthProfilesTable.slug, slug))
      .returning();
    req.log.info({ slug, statut }, "NovaLuth profile status updated");
    res.json(UpdateFicheStatusResponse.parse(updated.data));
  } catch (error) {
    next(error);
  }
});

router.get("/projets/:reference/portail/:token", async (req, res, next) => {
  try {
    await runMaintenance();
    const { reference, token } = GetMusicianProjectParams.parse(req.params);
    const [project] = await db
      .select()
      .from(novaluthProjectsTable)
      .where(
        and(
          eq(novaluthProjectsTable.reference, reference),
          eq(novaluthProjectsTable.musicianToken, token),
        ),
      );
    if (!project) {
      res.status(404).json({ error: "Ce lien de suivi est introuvable ou a expiré." });
      return;
    }
    const requests = await db
      .select()
      .from(novaluthAccessRequestsTable)
      .where(eq(novaluthAccessRequestsTable.projectReference, reference));
    const response = {
      ...projectForAtelier(project, true),
      statut: project.status,
      courriel_confirmation: project.email
        ? isNovaLuthEmailConfigured()
          ? "Les notifications de suivi sont envoyées à votre adresse renseignée."
          : "Votre adresse de suivi est enregistrée ; l’envoi des notifications est en cours de configuration."
        : "Conservez ce lien personnel pour suivre votre projet.",
      demandes: await Promise.all(requests.map((request) => requestForDisplay(request, true))),
    };
    res.json(GetMusicianProjectResponse.parse(response));
  } catch (error) {
    next(error);
  }
});

router.post("/projets/:reference/portail/:token/demandes/:requestId/decision", async (req, res, next) => {
  try {
    await runMaintenance();
    const { reference, token, requestId } = DecideMusicianAccessRequestParams.parse(req.params);
    const { decision } = DecideMusicianAccessRequestBody.parse(req.body);
    const decided = await db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(novaluthProjectsTable)
        .where(
          and(
            eq(novaluthProjectsTable.reference, reference),
            eq(novaluthProjectsTable.musicianToken, token),
          ),
        );
      const [request] = await tx
        .select()
        .from(novaluthAccessRequestsTable)
        .where(
          and(
            eq(novaluthAccessRequestsTable.id, requestId),
            eq(novaluthAccessRequestsTable.projectReference, reference),
          ),
        );
      if (!project || !request) return { error: "not_found" as const };
      if (request.status !== "en_attente") return { error: "already_decided" as const };

      const now = new Date();
      const accepted = decision === "accepter";
      const [updated] = await tx
        .update(novaluthAccessRequestsTable)
        .set({
          status: accepted ? "acceptee" : "refusee",
          paymentStatus: accepted ? "encaisse" : "annule",
          decidedAt: now,
          accessEndsAt: accepted ? new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000) : null,
        })
        .where(
          and(
            eq(novaluthAccessRequestsTable.id, request.id),
            eq(novaluthAccessRequestsTable.status, "en_attente"),
            eq(novaluthAccessRequestsTable.paymentStatus, "preautorise"),
          ),
        )
        .returning();
      if (!updated) return { error: "conflict" as const };

      await tx
        .update(novaluthProjectsTable)
        .set({ lastActivityAt: now, status: "actif" })
        .where(eq(novaluthProjectsTable.reference, reference));
      await notifyProjectEmail(
        project,
        accepted ? "decision_accepted" : "decision_refused",
        {
          plan: request.plan,
          accessEndsAt: updated.accessEndsAt,
        },
        tx,
        `${accepted ? "decision_accepted" : "decision_refused"}:${request.id}`,
      );
      return { updated };
    });
    if ("error" in decided && decided.error === "not_found") {
      res.status(404).json({ error: "La demande ou le lien personnel est introuvable." });
      return;
    }
    if ("error" in decided && decided.error === "already_decided") {
      res.status(400).json({ error: "Cette demande a déjà reçu une décision." });
      return;
    }
    if ("error" in decided && decided.error === "conflict") {
      res.status(409).json({ error: "Cette demande a reçu une décision entre-temps." });
      return;
    }
    req.log.info({ requestId, decision }, "NovaLuth access request decided");
    res.json(DecideMusicianAccessRequestResponse.parse(await requestForDisplay(decided.updated, true)));
  } catch (error) {
    next(error);
  }
});

router.post("/ateliers/:slug/session", async (req, res, next) => {
  try {
    await seedProfiles();
    const { slug } = OpenAtelierSessionParams.parse(req.params);
    const { code_demo: codeDemo } = OpenAtelierSessionBody.parse(req.body);
    if (codeDemo && codeDemo !== "NOVALUTH-DEMO") {
      res.status(401).json({ error: "Code de démonstration invalide." });
      return;
    }
    const [atelier] = await db
      .select()
      .from(novaluthProfilesTable)
      .where(and(eq(novaluthProfilesTable.slug, slug), eq(novaluthProfilesTable.status, publicStatus)));
    if (!atelier) {
      res.status(404).json({ error: "Atelier introuvable." });
      return;
    }
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const token = randomUUID();
    await db.insert(novaluthAtelierSessionsTable).values({
      token,
      atelierSlug: slug,
      expiresAt,
    });
    res.json(
      OpenAtelierSessionResponse.parse({
        session: token,
        atelier_slug: slug,
        expire_le: expiresAt.toISOString(),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/ateliers/:slug/tableau-de-bord", async (req, res, next) => {
  try {
    await runMaintenance();
    const { slug } = GetAtelierDashboardParams.parse(req.params);
    const session = await requireAtelierSession(slug, req.header("X-NovaLuth-Atelier-Session") ?? undefined);
    if (!session) {
      res.status(401).json({ error: "Session atelier invalide ou expirée." });
      return;
    }
    const [[atelier], requests] = await Promise.all([
      db.select().from(novaluthProfilesTable).where(eq(novaluthProfilesTable.slug, slug)),
      db.select().from(novaluthAccessRequestsTable).where(eq(novaluthAccessRequestsTable.atelierSlug, slug)),
    ]);
    const displayed = await Promise.all(
      requests.map((request) => requestForDisplay(request, request.status === "acceptee")),
    );
    const activeCount = requests.filter((request) =>
      activeRequestStatuses.includes(request.status as (typeof activeRequestStatuses)[number]),
    ).length;
    res.json(
      GetAtelierDashboardResponse.parse({
        atelier_slug: slug,
        atelier_nom: atelier ? getFiche(atelier.data).nom : slug,
        places_restantes: Math.max(0, 3 - activeCount),
        demandes: displayed.filter((request) => request.statut !== "acceptee"),
        carnets: displayed.filter((request) => request.statut === "acceptee" || request.statut === "expiree"),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/ateliers/:slug/projets", async (req, res, next) => {
  try {
    await runMaintenance();
    const { slug } = ListAtelierProjectsParams.parse(req.params);
    const session = await requireAtelierSession(slug, req.header("X-NovaLuth-Atelier-Session") ?? undefined);
    if (!session) {
      res.status(401).json({ error: "Session atelier invalide ou expirée." });
      return;
    }
    const [projects, ownRequests] = await Promise.all([
      db.select().from(novaluthProjectsTable).where(eq(novaluthProjectsTable.status, "actif")),
      db.select().from(novaluthAccessRequestsTable).where(eq(novaluthAccessRequestsTable.atelierSlug, slug)),
    ]);
    const requestedReferences = new Set(
      ownRequests
        .filter((request) => activeRequestStatuses.includes(request.status as (typeof activeRequestStatuses)[number]))
        .map((request) => request.projectReference),
    );
    const compatible = projects.filter((project) => {
      const recommended = project.recommendedAteliers as string[];
      return recommended.includes(slug) && !requestedReferences.has(project.reference);
    });
    res.json(ListAtelierProjectsResponse.parse(compatible.map((project) => projectForAtelier(project))));
  } catch (error) {
    next(error);
  }
});

router.post("/ateliers/:slug/demandes", async (req, res, next) => {
  try {
    await runMaintenance();
    const { slug } = CreateAtelierAccessRequestParams.parse(req.params);
    const input = CreateAtelierAccessRequestBody.parse(req.body);
    const session = await requireAtelierSession(slug, input.session);
    if (!session) {
      res.status(401).json({ error: "Session atelier invalide ou expirée." });
      return;
    }
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${slug}))`);
      const [target] = await tx
        .select()
        .from(novaluthProjectsTable)
        .where(eq(novaluthProjectsTable.reference, input.reference_projet));
      const activeRequests = await tx
        .select()
        .from(novaluthAccessRequestsTable)
        .where(eq(novaluthAccessRequestsTable.atelierSlug, slug));
      const [atelier] = await tx
        .select()
        .from(novaluthProfilesTable)
        .where(eq(novaluthProfilesTable.slug, slug));
      const current = activeRequests.filter((request) =>
        activeRequestStatuses.includes(request.status as (typeof activeRequestStatuses)[number]),
      );
      if (current.length >= 3) {
        return { error: "Votre atelier dispose déjà de trois demandes ou carnets actifs." };
      }
      if (
        !target ||
        target.status !== "actif" ||
        !(target.recommendedAteliers as string[]).includes(slug)
      ) {
        return { error: "Ce projet n’est pas disponible pour votre atelier." };
      }
      if (current.some((request) => request.projectReference === target.reference)) {
        return { error: "Une demande active existe déjà pour ce projet." };
      }
      const plan = accessPlans[input.offre];
      const [request] = await tx
        .insert(novaluthAccessRequestsTable)
        .values({
          projectReference: target.reference,
          atelierSlug: slug,
          plan: input.offre,
          amountCents: plan.amountCents,
          status: "en_attente",
          paymentStatus: "preautorise",
          followupCredits: plan.followupCredits,
          paymentReference: `sim_${randomUUID()}`,
        })
        .returning();
      const now = new Date();
      await tx
        .update(novaluthProjectsTable)
        .set({ lastActivityAt: now })
        .where(eq(novaluthProjectsTable.reference, target.reference));
      await notifyProjectEmail(
        target,
        "access_request",
        {
          atelierName: atelier ? getFiche(atelier.data).nom : slug,
          plan: request.plan,
        },
        tx,
        `access_request:${request.id}`,
      );
      return { request };
    });
    if ("error" in created) {
      res.status(400).json({ error: created.error });
      return;
    }
    const request = created.request;
    req.log.info({ requestId: request.id, atelier: slug, plan: input.offre }, "NovaLuth payment preauthorized");
    const displayedRequest = await requestForDisplay(request);
    res.status(201).json(CreateAtelierAccessRequestResponse.parse(displayedRequest));
  } catch (error) {
    next(error);
  }
});

router.post("/ateliers/:slug/demandes/:requestId/annulation", async (req, res, next) => {
  try {
    await runMaintenance();
    const { slug, requestId } = CancelAtelierAccessRequestParams.parse(req.params);
    const { session: token } = CancelAtelierAccessRequestBody.parse(req.body);
    if (!(await requireAtelierSession(slug, token))) {
      res.status(401).json({ error: "Session atelier invalide ou expirée." });
      return;
    }
    const cancelled = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(novaluthAccessRequestsTable)
        .set({ status: "annulee", paymentStatus: "annule", decidedAt: new Date() })
        .where(
          and(
            eq(novaluthAccessRequestsTable.id, requestId),
            eq(novaluthAccessRequestsTable.atelierSlug, slug),
            eq(novaluthAccessRequestsTable.status, "en_attente"),
            eq(novaluthAccessRequestsTable.paymentStatus, "preautorise"),
          ),
        )
        .returning();
      if (!updated) return null;

      const [project] = await tx
        .select()
        .from(novaluthProjectsTable)
        .where(eq(novaluthProjectsTable.reference, updated.projectReference));
      if (project) {
        await notifyProjectEmail(
          project,
          "request_cancelled",
          { plan: updated.plan },
          tx,
          `request_cancelled:${updated.id}`,
        );
      }
      return updated;
    });
    if (!cancelled) {
      res.status(400).json({ error: "Cette demande ne peut plus être annulée." });
      return;
    }
    res.json(CancelAtelierAccessRequestResponse.parse(await requestForDisplay(cancelled)));
  } catch (error) {
    next(error);
  }
});

router.post("/ateliers/:slug/carnets/:requestId/relance", async (req, res, next) => {
  try {
    await runMaintenance();
    const { slug, requestId } = UseAtelierFollowupCreditParams.parse(req.params);
    const { session: token } = UseAtelierFollowupCreditBody.parse(req.body);
    if (!(await requireAtelierSession(slug, token))) {
      res.status(401).json({ error: "Session atelier invalide ou expirée." });
      return;
    }
    const now = new Date();
    const followedUp = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(novaluthAccessRequestsTable)
        .set({
          followupCredits: sql`${novaluthAccessRequestsTable.followupCredits} - 1`,
          lastFollowupAt: now,
        })
        .where(
          and(
            eq(novaluthAccessRequestsTable.id, requestId),
            eq(novaluthAccessRequestsTable.atelierSlug, slug),
            eq(novaluthAccessRequestsTable.status, "acceptee"),
            eq(novaluthAccessRequestsTable.paymentStatus, "encaisse"),
            gt(novaluthAccessRequestsTable.followupCredits, 0),
            gt(novaluthAccessRequestsTable.accessEndsAt, now),
          ),
        )
        .returning();
      if (!updated) return null;

      await tx
        .update(novaluthProjectsTable)
        .set({ lastActivityAt: now, status: "actif" })
        .where(eq(novaluthProjectsTable.reference, updated.projectReference));
      const [project] = await tx
        .select()
        .from(novaluthProjectsTable)
        .where(eq(novaluthProjectsTable.reference, updated.projectReference));
      if (project) {
        await notifyProjectEmail(
          project,
          "followup",
          { plan: updated.plan, accessEndsAt: updated.accessEndsAt },
          tx,
          `followup:${updated.id}:${updated.lastFollowupAt?.toISOString() ?? now.toISOString()}`,
        );
      }
      return updated;
    });
    if (!followedUp) {
      res.status(400).json({ error: "Aucun crédit de relance disponible pour ce carnet actif." });
      return;
    }
    res.json(UseAtelierFollowupCreditResponse.parse(await requestForDisplay(followedUp, true)));
  } catch (error) {
    next(error);
  }
});

router.post("/admin/acces/entretien", async (req, res, next) => {
  try {
    if (!requireAdminToken(req.header("X-Admin-Token") ?? undefined)) {
      res.status(401).json({ error: "Jeton d’administration invalide." });
      return;
    }
    res.json(RunAccessMaintenanceResponse.parse(await runMaintenance()));
  } catch (error) {
    next(error);
  }
});

router.post("/admin/telegram/test", async (req, res, next) => {
  try {
    if (!requireAdminToken(req.header("X-Admin-Token") ?? undefined)) {
      res.status(401).json({ error: "Jeton d’administration invalide." });
      return;
    }

    const telegramResponse = await sendNovaLuthTelegramMessage(
      novaLuthTelegramTestMessage,
    );
    res.json(telegramResponse);
  } catch (error) {
    next(error);
  }
});

export default router;