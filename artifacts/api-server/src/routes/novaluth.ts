import { and, eq, gte } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateBriefBody,
  CreateBriefResponse,
  GetAdminSummaryResponse,
  GetFicheParams,
  GetFicheResponse,
  GetFichesMetaResponse,
  ListFichesQueryParams,
  ListFichesResponse,
  RecommendBody,
  RecommendResponse,
  UpdateFicheStatusBody,
  UpdateFicheStatusParams,
  UpdateFicheStatusResponse,
} from "@workspace/api-zod";
import { db, novaluthBriefsTable, novaluthProfilesTable } from "@workspace/db";
import { novaluthSeed } from "../data/novaluth-seed";

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
  chaleur_souhaitee?: number | null;
  brillance_souhaitee?: number | null;
  innovation_recherchee?: number | null;
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
  return GetFicheResponse.parse(data);
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

  const soundDistances = [
    brief.chaleur_souhaitee != null && fiche.profil_sonore.chaleur != null
      ? Math.abs(brief.chaleur_souhaitee - fiche.profil_sonore.chaleur)
      : null,
    brief.brillance_souhaitee != null && fiche.profil_sonore.brillance != null
      ? Math.abs(brief.brillance_souhaitee - fiche.profil_sonore.brillance)
      : null,
  ].filter((value): value is number => value !== null);
  if (soundDistances.length) {
    const proximity = 1 - soundDistances.reduce((total, value) => total + value, 0) / soundDistances.length / 10;
    score += Math.round(8 * Math.max(0, proximity));
    if (proximity >= 0.7) points.push("Le profil sonore est proche de ce que vous décrivez.");
  }

  const innovation = fiche.innovation.niveau ?? fiche.score_innovation ?? 0;
  if (brief.innovation_recherchee != null) {
    score += Math.round(8 * Math.max(0, 1 - Math.abs(brief.innovation_recherchee - innovation) / 10));
  } else if (innovation >= 7) {
    score += 5;
  }
  if (innovation >= 7) points.push("La démarche technique originale est documentée.");

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
  const rows = await db
    .select()
    .from(novaluthProfilesTable)
    .where(eq(novaluthProfilesTable.status, publicStatus));
  return rows
    .map((row) => evaluateMatch(brief, getFiche(row.data)))
    .filter((result) => result.correspondance > 0)
    .sort((left, right) => right.correspondance - left.correspondance)
    .slice(0, 3);
}

function requireAdminToken(token: string | undefined) {
  const expected = process.env.NOVALUTH_ADMIN_TOKEN ?? "demo-admin";
  return token === expected;
}

router.get("/fiches", async (req, res, next) => {
  try {
    await seedProfiles();
    const parsed = ListFichesQueryParams.parse({
      pays: typeof req.query.pays === "string" ? req.query.pays : undefined,
      type: typeof req.query.type === "string" ? req.query.type : undefined,
      innovation_min:
        typeof req.query.innovation_min === "string"
          ? Number(req.query.innovation_min)
          : undefined,
      statut: typeof req.query.statut === "string" ? req.query.statut : undefined,
    });
    const conditions = [eq(novaluthProfilesTable.status, parsed.statut ?? publicStatus)];
    if (parsed.pays) conditions.push(eq(novaluthProfilesTable.country, parsed.pays));
    if (parsed.type) conditions.push(eq(novaluthProfilesTable.entityType, parsed.type));
    if (parsed.innovation_min) {
      conditions.push(gte(novaluthProfilesTable.innovationScore, parsed.innovation_min));
    }
    const rows = await db
      .select()
      .from(novaluthProfilesTable)
      .where(and(...conditions))
      .orderBy(novaluthProfilesTable.name);
    res.json(ListFichesResponse.parse(rows.map((row) => row.data)));
  } catch (error) {
    next(error);
  }
});

router.get("/fiches/meta", async (_req, res, next) => {
  try {
    await seedProfiles();
    const rows = await db.select().from(novaluthProfilesTable);
    const published = rows.filter((row) => row.status === publicStatus);
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
        pays: [...new Set(rows.flatMap((row) => (row.country ? [row.country] : [])))].sort(),
        types,
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
    res.json(GetFicheResponse.parse(row.data));
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
    const resultats = await recommendations(brief);
    const [saved] = await db
      .insert(novaluthBriefsTable)
      .values({
        criteria: { ...brief, email: undefined },
        email: brief.consentement_transmission ? brief.email ?? null : null,
        consent: Boolean(brief.consentement_transmission),
        recommendations: resultats,
      })
      .returning();
    res.status(201).json(
      CreateBriefResponse.parse({
        reference: saved.reference,
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
    const rows = await db.select().from(novaluthProfilesTable);
    const compteurs = Object.fromEntries(
      statuses.map((status) => [status, rows.filter((row) => row.status === status).length]),
    );
    res.json(
      GetAdminSummaryResponse.parse({
        compteurs,
        fiches: rows
          .filter((row) => row.status !== "rejetee" && row.status !== "trop_etablie")
          .map((row) => row.data),
        passerelle: "moteur de correspondance local",
      }),
    );
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

export default router;