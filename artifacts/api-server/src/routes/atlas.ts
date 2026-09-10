import { and, eq, isNull } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import {
  db,
  novaluthAtlasPointsTable,
  novaluthProfilesTable,
  type NovaluthAtlasPoint,
} from "@workspace/db";
import { accountForSession, sessionTokenFromCookie } from "../lib/p2p-meet-auth";
import { logger } from "../lib/logger";

/**
 * Atlas des luthiers d'Europe.
 *
 * Règles :
 *  - lecture publique : seules les fiches au statut « publiee » apparaissent,
 *    plus les points saisis par un administrateur ;
 *  - une fiche publiée sans coordonnées est géolocalisée automatiquement
 *    (ville + pays) à la première synchronisation, puis mise en cache ;
 *  - la saisie et la correction manuelles sont réservées aux comptes admin ;
 *  - un luthier ne saisit jamais ici : il passe par son dossier NovaLuth.
 */

const router: IRouter = Router();
const publicStatus = "publiee";
const geocodageEnabled = process.env.ATLAS_GEOCODAGE !== "off";
const geocodageEndpoint =
  process.env.ATLAS_GEOCODAGE_URL ?? "https://photon.komoot.io/api/";

const codesPays: Record<string, string> = {
  France: "fr",
  Belgique: "be",
  Suisse: "ch",
  Allemagne: "de",
  Italie: "it",
  Espagne: "es",
  Portugal: "pt",
  "Pays-Bas": "nl",
  Autriche: "at",
  "Royaume-Uni": "gb",
  Irlande: "ie",
  Pologne: "pl",
  Tchequie: "cz",
  "République tchèque": "cz",
  Slovaquie: "sk",
  Hongrie: "hu",
  Roumanie: "ro",
  Bulgarie: "bg",
  Grece: "gr",
  Grèce: "gr",
  Croatie: "hr",
  Slovenie: "si",
  Slovénie: "si",
  Serbie: "rs",
  Danemark: "dk",
  Suede: "se",
  Suède: "se",
  Norvege: "no",
  Norvège: "no",
  Finlande: "fi",
  Estonie: "ee",
  Lettonie: "lv",
  Lituanie: "lt",
  Luxembourg: "lu",
  Ukraine: "ua",
  Islande: "is",
};

/**
 * Centre approximatif de chaque pays : filet de sécurité quand le géocodeur
 * est indisponible. La fiche publiée apparaît quand même sur la carte, avec
 * la précision « pays », et sera affinée automatiquement plus tard.
 */
const centresPays: Record<string, { latitude: number; longitude: number }> = {
  fr: { latitude: 46.6, longitude: 2.4 },
  be: { latitude: 50.6, longitude: 4.6 },
  ch: { latitude: 46.8, longitude: 8.2 },
  de: { latitude: 51.1, longitude: 10.4 },
  it: { latitude: 42.8, longitude: 12.5 },
  es: { latitude: 40.2, longitude: -3.7 },
  pt: { latitude: 39.6, longitude: -8.0 },
  nl: { latitude: 52.2, longitude: 5.5 },
  at: { latitude: 47.6, longitude: 14.1 },
  gb: { latitude: 54.0, longitude: -2.2 },
  ie: { latitude: 53.2, longitude: -8.0 },
  pl: { latitude: 52.1, longitude: 19.4 },
  cz: { latitude: 49.8, longitude: 15.4 },
  sk: { latitude: 48.7, longitude: 19.5 },
  hu: { latitude: 47.2, longitude: 19.4 },
  ro: { latitude: 45.9, longitude: 25.0 },
  bg: { latitude: 42.7, longitude: 25.3 },
  gr: { latitude: 39.1, longitude: 22.0 },
  hr: { latitude: 45.1, longitude: 15.9 },
  si: { latitude: 46.1, longitude: 14.8 },
  rs: { latitude: 44.2, longitude: 20.8 },
  dk: { latitude: 56.0, longitude: 9.8 },
  se: { latitude: 62.2, longitude: 15.5 },
  no: { latitude: 64.0, longitude: 11.5 },
  fi: { latitude: 64.0, longitude: 26.0 },
  ee: { latitude: 58.7, longitude: 25.4 },
  lv: { latitude: 56.9, longitude: 24.9 },
  lt: { latitude: 55.3, longitude: 23.9 },
  lu: { latitude: 49.8, longitude: 6.1 },
  ua: { latitude: 49.0, longitude: 31.4 },
  is: { latitude: 64.9, longitude: -18.6 },
};

/** Nombre d'appels au géocodeur autorisés par synchronisation. */
const geocodagesParSync = 8;
/** Pause entre deux appels : Photon limite le rythme des requêtes. */
const pauseGeocodage = 1200;
/** Passe à vrai quand le service refuse (429) : on n'insiste pas. */
let quotaAtteint = false;

type Compte = { id: number; role: string } | null;

async function compteConnecte(req: Request): Promise<Compte> {
  try {
    const account = await accountForSession(
      sessionTokenFromCookie(req.header("cookie")),
    );
    return account ? { id: account.id, role: account.role } : null;
  } catch {
    return null;
  }
}

function jetonAdminValide(req: Request) {
  const attendu = process.env.NOVALUTH_ADMIN_TOKEN;
  const recu = req.header("X-Admin-Token");
  return Boolean(attendu && recu && recu === attendu);
}

async function exigerAdmin(req: Request) {
  if (jetonAdminValide(req)) return { id: 0, role: "admin" };
  const compte = await compteConnecte(req);
  return compte?.role === "admin" ? compte : null;
}

/* ------------------------------------------------------------------ */
/* Géocodage (Photon / OpenStreetMap), utilisé une seule fois par fiche */
/* ------------------------------------------------------------------ */

const pause = (ms: number) =>
  new Promise<void>((resoudre) => setTimeout(resoudre, ms));

/** Secours quand Photon refuse : Nominatim (OpenStreetMap). */
async function geocoderNominatim(requete: string, code: string | undefined) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", requete);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  if (code) url.searchParams.set("countrycodes", code);
  try {
    const reponse = await fetch(url, {
      headers: {
        Accept: "application/json",
        // Nominatim exige une identification de l'application.
        "User-Agent": "NovaLuth-Atlas/1.0 (contact@novaluth.fr)",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!reponse.ok) return null;
    const data = (await reponse.json()) as Array<{ lat?: string; lon?: string }>;
    const premier = data[0];
    if (!premier?.lat || !premier?.lon) return null;
    return { latitude: Number(premier.lat), longitude: Number(premier.lon) };
  } catch {
    return null;
  }
}

async function geocoder(ville: string | null, pays: string) {
  if (!geocodageEnabled || quotaAtteint) return null;
  const requete = [ville, pays].filter(Boolean).join(", ");
  if (!requete) return null;
  const url = new URL(geocodageEndpoint);
  url.searchParams.set("q", requete);
  url.searchParams.set("limit", "1");
  url.searchParams.set("lang", "fr");
  const code = codesPays[pays];
  if (code) url.searchParams.set("countrycode", code);
  try {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), 8000);
    const reponse = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controleur.signal,
    });
    clearTimeout(minuteur);
    if (!reponse.ok) {
      // 429 = quota Photon atteint : on arrête les appels jusqu'à la prochaine synchronisation.
      if (reponse.status === 429) quotaAtteint = true;
      logger.warn(
        { statut: reponse.status, requete },
        "[atlas] géocodage refusé, tentative de secours",
      );
      return geocoderNominatim(requete, code);
    }
    const data = (await reponse.json()) as {
      features?: Array<{ geometry?: { coordinates?: [number, number] } }>;
    };
    const coords = data.features?.[0]?.geometry?.coordinates;
    if (!coords) return null;
    return { longitude: coords[0], latitude: coords[1] };
  } catch (erreur) {
    logger.warn(
      { err: erreur, requete },
      "[atlas] géocodage indisponible, tentative de secours",
    );
    return geocoderNominatim(requete, code);
  }
}

/**
 * Diagnostic réservé aux administrateurs : sert à comprendre en une requête
 * pourquoi la carte serait vide (aucune fiche publiée, géocodeur injoignable...).
 */
router.get("/atlas/diagnostic", async (req, res) => {
  const admin = await exigerAdmin(req);
  if (!admin) {
    res.status(403).json({ erreur: "reserve_admin" });
    return;
  }
  const debut = Date.now();
  let geocodeur: Record<string, unknown> = { actif: geocodageEnabled };
  if (geocodageEnabled) {
    const essai = await geocoder("Cremona", "Italie");
    geocodeur = {
      actif: true,
      service: geocodageEndpoint,
      joignable: Boolean(essai),
      ms: Date.now() - debut,
    };
  }
  const profils = await db
    .select()
    .from(novaluthProfilesTable)
    .where(eq(novaluthProfilesTable.status, publicStatus));
  const points = await db.select().from(novaluthAtlasPointsTable);
  res.set("Cache-Control", "no-store");
  res.json({
    fiches_publiees: profils.length,
    points_en_base: points.length,
    points_masques: points.filter((p) => p.masque).length,
    points_precision_pays: points.filter((p) => p.precisionGeo === "pays").length,
    sans_pays_reconnu: profils
      .filter((p) => !codesPays[p.country ?? ""])
      .map((p) => ({ slug: p.slug, pays: p.country })),
    geocodeur,
  });
});

function centreDuPays(pays: string) {
  const code = codesPays[pays];
  return code ? (centresPays[code] ?? null) : null;
}

/* ------------------------------------------------------------------ */
/* Conversion vers le format attendu par la carte                      */
/* ------------------------------------------------------------------ */

function instrumentsParDefaut(data: Record<string, unknown>) {
  const modeles = Array.isArray(data.modeles) ? data.modeles : [];
  const types = new Set(
    modeles.map((m) => String((m as { type?: unknown }).type ?? "")),
  );
  return types.has("contrebasse") ? "contrebasse" : "guitare";
}

function pointVersFiche(point: NovaluthAtlasPoint) {
  return {
    id: point.id,
    slug: point.slug,
    nom: point.nom,
    ville: point.ville,
    pays: point.pays,
    adresse: point.adresse,
    instruments: point.instruments,
    specialisations: point.specialisations,
    telephone: point.telephone,
    email: point.email,
    site_web: point.siteWeb,
    association: point.association ?? "NovaLuth",
    source_url: point.sourceUrl,
    latitude: point.latitude,
    longitude: point.longitude,
    precision: point.precisionGeo,
    // Un point saisi par un administrateur est validé par définition :
    // la carte n'affiche que les fiches au statut « publiee ».
    statut: "publiee",
    origine: point.origine,
    maj: point.updatedAt.toISOString(),
  };
}

function texteListe(valeur: unknown) {
  if (Array.isArray(valeur)) return valeur.filter(Boolean).join(";") || null;
  if (typeof valeur === "string") return valeur.trim() || null;
  return null;
}

function texte(valeur: unknown) {
  if (typeof valeur !== "string") return null;
  const propre = valeur.trim();
  return propre === "" ? null : propre;
}

function nombre(valeur: unknown) {
  const n = typeof valeur === "string" ? Number(valeur.replace(",", ".")) : valeur;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function corpsAdmin(corps: Record<string, unknown>) {
  return {
    nom: texte(corps.nom),
    pays: texte(corps.pays),
    ville: texte(corps.ville),
    adresse: texte(corps.adresse),
    instruments: texteListe(corps.instruments),
    specialisations: texteListe(corps.specialisations),
    telephone: texte(corps.telephone),
    email: texte(corps.email),
    siteWeb: texte(corps.site_web),
    association: texte(corps.association),
    sourceUrl: texte(corps.source_url),
    latitude: nombre(corps.latitude),
    longitude: nombre(corps.longitude),
    precisionGeo: texte(corps.precision_geocodage) ?? texte(corps.precision),
  };
}

function coordonneesValides(latitude: number | null, longitude: number | null) {
  return (
    latitude !== null &&
    longitude !== null &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */

/** Rôle de la personne connectée : la carte s'en sert pour afficher la saisie. */
router.get("/atlas/session", async (req, res) => {
  const compte = await compteConnecte(req);
  const admin = compte?.role === "admin" || jetonAdminValide(req);
  res.set("Cache-Control", "no-store");
  res.json({ role: admin ? "admin" : (compte?.role ?? "public"), admin });
});

/** Lecture publique : fiches publiées + points saisis par un administrateur. */
router.get("/atlas/luthiers", async (_req, res) => {
  try {
    const [profils, points] = await Promise.all([
      db
        .select()
        .from(novaluthProfilesTable)
        .where(eq(novaluthProfilesTable.status, publicStatus)),
      db.select().from(novaluthAtlasPointsTable),
    ]);

    const parSlug = new Map(
      points.filter((p) => p.slug).map((p) => [p.slug as string, p]),
    );
    const publies = new Set(profils.map((profil) => profil.slug));

    let budgetGeocodage = geocodagesParSync;
    quotaAtteint = false;
    let premierAppel = true;
    const appelGeocodeur = async (ville: string | null, pays: string) => {
      if (budgetGeocodage <= 0 || quotaAtteint) return null;
      budgetGeocodage -= 1;
      if (!premierAppel) await pause(pauseGeocodage);
      premierAppel = false;
      return geocoder(ville, pays);
    };

    // Une fiche publiée sans point : on la géolocalise une fois puis on garde le résultat.
    // Si le géocodeur ne répond pas, on place la fiche au centre de son pays :
    // elle reste visible sur la carte et sera affinée à une prochaine synchronisation.
    for (const profil of profils) {
      if (parSlug.has(profil.slug)) continue;
      const pays = profil.country ?? "";
      let precision = "ville";
      let coords = await appelGeocodeur(profil.city, pays);
      if (!coords) {
        coords = centreDuPays(pays);
        precision = "pays";
      }
      if (!coords) continue;
      const data = (profil.data ?? {}) as Record<string, unknown>;
      const [cree] = await db
        .insert(novaluthAtlasPointsTable)
        .values({
          slug: profil.slug,
          nom: profil.name,
          pays: profil.country ?? "",
          ville: profil.city,
          instruments: instrumentsParDefaut(data),
          specialisations: "fabrication",
          siteWeb: texte(data.site_web),
          association: "NovaLuth",
          sourceUrl: `/atelier/${profil.slug}`,
          latitude: coords.latitude,
          longitude: coords.longitude,
          precisionGeo: precision,
          origine: "novaluth",
        })
        .onConflictDoNothing()
        .returning();
      if (cree) parSlug.set(profil.slug, cree);
    }

    // Affinage progressif des fiches posées au centre d'un pays.
    for (const point of parSlug.values()) {
      if (budgetGeocodage <= 0 || quotaAtteint) break;
      if (point.origine !== "novaluth" || point.precisionGeo !== "pays") continue;
      if (!point.ville) continue;
      const coords = await appelGeocodeur(point.ville, point.pays);
      if (!coords) continue;
      const [affine] = await db
        .update(novaluthAtlasPointsTable)
        .set({
          latitude: coords.latitude,
          longitude: coords.longitude,
          precisionGeo: "ville",
          updatedAt: new Date(),
        })
        .where(eq(novaluthAtlasPointsTable.id, point.id))
        .returning();
      if (affine && affine.slug) parSlug.set(affine.slug, affine);
    }

    const visibles = [
      ...parSlug.values(),
      ...points.filter((p) => !p.slug),
    ].filter((point) => !point.masque && (!point.slug || publies.has(point.slug)));

    res.set("Cache-Control", "no-store");
    res.json({
      fiches: visibles.map(pointVersFiche),
      total: visibles.length,
      maj: new Date().toISOString(),
    });
  } catch (erreur) {
    logger.error({ erreur }, "[atlas] lecture impossible");
    res.status(500).json({ erreur: "lecture_impossible" });
  }
});

/** Création d'un point — administrateurs uniquement. */
router.post("/atlas/luthiers", async (req, res) => {
  const admin = await exigerAdmin(req);
  if (!admin) {
    res.status(403).json({
      erreur: "admin_requis",
      message:
        "La saisie manuelle de l'atlas est réservée aux administrateurs NovaLuth.",
    });
    return;
  }
  const d = corpsAdmin((req.body ?? {}) as Record<string, unknown>);
  if (!d.nom || !d.pays) {
    res.status(400).json({ erreur: "champs_manquants", message: "Nom et pays obligatoires." });
    return;
  }
  if (!coordonneesValides(d.latitude, d.longitude)) {
    res.status(400).json({ erreur: "coordonnees_invalides" });
    return;
  }
  try {
    const [cree] = await db
      .insert(novaluthAtlasPointsTable)
      .values({
        nom: d.nom,
        pays: d.pays,
        ville: d.ville,
        adresse: d.adresse,
        instruments: d.instruments,
        specialisations: d.specialisations,
        telephone: d.telephone,
        email: d.email,
        siteWeb: d.siteWeb,
        association: d.association,
        sourceUrl: d.sourceUrl,
        latitude: d.latitude as number,
        longitude: d.longitude as number,
        precisionGeo: d.precisionGeo ?? "manuel",
        origine: "manuel",
        creePar: String(admin.id),
      })
      .returning();
    res.status(201).json(pointVersFiche(cree));
  } catch (erreur) {
    logger.error({ erreur }, "[atlas] création impossible");
    res.status(500).json({ erreur: "creation_impossible" });
  }
});

/** Correction d'un point — administrateurs uniquement. */
router.patch("/atlas/luthiers/:id", async (req, res) => {
  const admin = await exigerAdmin(req);
  if (!admin) {
    res.status(403).json({ erreur: "admin_requis" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ erreur: "identifiant_invalide" });
    return;
  }
  const d = corpsAdmin((req.body ?? {}) as Record<string, unknown>);
  if (
    (d.latitude !== null || d.longitude !== null) &&
    !coordonneesValides(d.latitude, d.longitude)
  ) {
    res.status(400).json({ erreur: "coordonnees_invalides" });
    return;
  }
  const modifications = Object.fromEntries(
    Object.entries(d).filter(([, valeur]) => valeur !== null),
  );
  if (Object.keys(modifications).length === 0) {
    res.status(400).json({ erreur: "rien_a_modifier" });
    return;
  }
  try {
    const [modifie] = await db
      .update(novaluthAtlasPointsTable)
      .set({ ...modifications, masque: false })
      .where(eq(novaluthAtlasPointsTable.id, id))
      .returning();
    if (!modifie) {
      res.status(404).json({ erreur: "introuvable" });
      return;
    }
    res.json(pointVersFiche(modifie));
  } catch (erreur) {
    logger.error({ erreur }, "[atlas] modification impossible");
    res.status(500).json({ erreur: "modification_impossible" });
  }
});

/**
 * Retrait de la carte — administrateurs uniquement.
 * Un point manuel est supprimé ; un point rattaché à une fiche est masqué,
 * le dossier NovaLuth n'est jamais touché.
 */
router.delete("/atlas/luthiers/:id", async (req, res) => {
  const admin = await exigerAdmin(req);
  if (!admin) {
    res.status(403).json({ erreur: "admin_requis" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ erreur: "identifiant_invalide" });
    return;
  }
  try {
    const [manuel] = await db
      .delete(novaluthAtlasPointsTable)
      .where(
        and(
          eq(novaluthAtlasPointsTable.id, id),
          isNull(novaluthAtlasPointsTable.slug),
        ),
      )
      .returning();
    if (manuel) {
      res.json({ ok: true, retire: "point_manuel" });
      return;
    }
    const [masque] = await db
      .update(novaluthAtlasPointsTable)
      .set({ masque: true })
      .where(eq(novaluthAtlasPointsTable.id, id))
      .returning();
    if (!masque) {
      res.status(404).json({ erreur: "introuvable" });
      return;
    }
    res.json({ ok: true, retire: "masque" });
  } catch (erreur) {
    logger.error({ erreur }, "[atlas] retrait impossible");
    res.status(500).json({ erreur: "retrait_impossible" });
  }
});

export default router;
