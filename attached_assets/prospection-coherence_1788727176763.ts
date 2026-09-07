/**
 * Novaluth — Prospection · LOT 1B : lecture de page et contrôle de cohérence
 * ==========================================================================
 *
 * Emplacement : artifacts/api-server/src/lib/prospection/prospection-coherence.ts
 *
 * La lecture passe exclusivement par `readPublicPage()`, qui porte déjà le
 * respect de robots.txt, des réservations de fouille de données et du délai de
 * politesse. Ce module n'ouvre aucune connexion sortante par lui-même.
 *
 * ⚠️ SIGNATURE RÉELLE DE readPublicPage
 * -------------------------------------
 * En cas de succès, elle résout un objet aux champs français :
 *
 *     { url, url_finale, titre, texte, octets, delai_respecte_s }
 *
 * En cas de refus, elle NE renvoie aucun objet : la promesse est REJETÉE avec
 * une instance de `PageReadRefused`. Les messages connus sont :
 *
 *     « robots.txt interdit cette lecture »
 *     « réservation de fouille déclarée dans /.well-known/tdmrep.json »
 *     « le site réserve la fouille de données »
 *
 * Le code ci-dessous distingue donc un refus légitime — le dossier passe en
 * « inconsistent » avec le motif read_refused — d'une indisponibilité technique,
 * qui ne change pas l'état et sera simplement retentée plus tard.
 *
 * LE GARDE-FOU CENTRAL
 * --------------------
 * Le contrôle de cohérence refuse de produire un brouillon quand le nom ou la
 * ville de la fiche n'apparaissent pas sur la page de l'atelier. C'est ce qui
 * empêche d'écrire « votre atelier de Cestas » à un luthier installé à Estaires.
 */

import { eq } from "drizzle-orm";

import {
  db,
  prospectionDossiers,
  PROSPECTION_MIN_SIGNALS,
  type ProspectionReason,
  type ProspectionState,
} from "@workspace/db";

// ⚠️ CHEMINS À CONFIRMER : ajuster si ces symboles sont exportés ailleurs.
import { readPublicPage, PageReadRefused } from "../../gateway/page-harvester";

import {
  journal,
  sanitiseSignals,
  transition,
  isOpposed,
  TransitionRefused,
} from "./prospection-service";

/* -------------------------------------------------------------------------- */
/* 1. Forme attendue d'une fiche d'annuaire                                   */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ ADAPTER aux champs réels de votre table de profils. Seuls ces champs sont
 * utilisés par le contrôle de cohérence.
 */
export interface WorkshopRecord {
  slug: string;
  name: string;
  city?: string | null;
  country?: string | null;
  foundedYear?: number | null;
  websiteUrl?: string | null;
  innovationMarkers?: string[] | null;
  models?: { name: string }[] | null;
}

/** À remplacer par votre fonction de lecture de fiche existante. */
export type WorkshopLoader = (slug: string) => Promise<WorkshopRecord | null>;

/* -------------------------------------------------------------------------- */
/* 2. Normalisation                                                           */
/* -------------------------------------------------------------------------- */

/** Minuscules, sans accent, sans ponctuation : comparaison sans faux négatif. */
export function normalise(input: string | null | undefined): string {
  return (input ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* 3. Contrôle de cohérence                                                   */
/* -------------------------------------------------------------------------- */

const MIN_PAGE_LENGTH = 400;

export interface CoherenceResult {
  accepted: boolean;
  signals: string[];
  reason?: ProspectionReason;
}

/**
 * Vérifie que la fiche décrit bien l'atelier dont la page vient d'être lue.
 *
 * Deux refus sont bloquants et sans exception :
 *   · le nom de l'atelier n'apparaît pas sur sa propre page ;
 *   · la ville annoncée par la fiche n'apparaît pas sur la page.
 */
export function checkCoherence(workshop: WorkshopRecord, pageText: string): CoherenceResult {
  const page = normalise(pageText);
  if (page.length < MIN_PAGE_LENGTH) {
    return { accepted: false, signals: [], reason: "page_too_short" };
  }

  const signals: string[] = [];

  const nameWords = normalise(workshop.name)
    .split(" ")
    .filter((word) => word.length > 3);
  const nameFound = nameWords.length > 0 && nameWords.slice(0, 3).every((w) => page.includes(w));
  if (!nameFound) {
    return { accepted: false, signals: [], reason: "name_absent_from_page" };
  }
  signals.push(`nom « ${workshop.name} »`);

  if (workshop.city) {
    if (!page.includes(normalise(workshop.city))) {
      return { accepted: false, signals, reason: "city_absent_from_page" };
    }
    signals.push(`ville « ${workshop.city} »`);
  }

  if (workshop.country && page.includes(normalise(workshop.country))) {
    signals.push(`pays « ${workshop.country} »`);
  }
  if (workshop.foundedYear && page.includes(String(workshop.foundedYear))) {
    signals.push(`création ${workshop.foundedYear}`);
  }
  for (const marker of (workshop.innovationMarkers ?? []).slice(0, 4)) {
    const target = normalise(marker);
    if (target && page.includes(target)) signals.push(`« ${marker} »`);
  }
  for (const model of (workshop.models ?? []).slice(0, 4)) {
    const target = normalise(model.name);
    if (target.length > 3 && page.includes(target)) signals.push(`modèle « ${model.name} »`);
  }

  if (signals.length < PROSPECTION_MIN_SIGNALS) {
    return { accepted: false, signals, reason: "insufficient_signals" };
  }
  return { accepted: true, signals };
}

/* -------------------------------------------------------------------------- */
/* 4. Adresse de contact                                                      */
/* -------------------------------------------------------------------------- */

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g;
const IGNORED_FRAGMENTS = [
  "example.",
  "sentry",
  "wixpress",
  "no-reply",
  "noreply",
  "@2x",
  "cloudflare",
  "godaddy",
  "domain",
  "yourdomain",
];

/** Relève une adresse professionnelle publiée sur la page, si elle y figure. */
export function extractContactEmail(pageText: string): string | null {
  for (const candidate of pageText.match(EMAIL_PATTERN) ?? []) {
    const lower = candidate.toLowerCase();
    if (lower.length > 320) continue;
    if (!IGNORED_FRAGMENTS.some((fragment) => lower.includes(fragment))) return candidate;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 5. Accroche déterministe                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Accroche construite uniquement d'éléments vérifiés sur la page.
 *
 * Le marqueur « [À compléter à la main » est intentionnel : le service refuse de
 * valider une accroche qui le contient encore. C'est vous qui écrivez la phrase
 * précise, et c'est elle qui fait la différence auprès d'un artisan.
 *
 * Le lot 2 remplacera cette fonction par une rédaction assistée produisant
 * `hookOrigin = 'ai'`, soumise au même contrôle de validation humaine.
 */
export function buildHookFromSignals(workshop: WorkshopRecord): string {
  const parts: string[] = [workshop.city ? `votre atelier de ${workshop.city}` : "votre atelier"];
  if (workshop.foundedYear) parts.push(`installé depuis ${workshop.foundedYear}`);

  const markers = (workshop.innovationMarkers ?? []).filter(Boolean).slice(0, 2);
  const detail = markers.length ? `, et notamment votre travail autour de ${markers.join(", ")}` : "";

  return [
    `J'ai lu la présentation de ${parts.join(" ")}${detail}.`,
    "C'est exactement le type de savoir-faire indépendant que je souhaite mettre en avant.",
    "",
    "[À compléter à la main : une ou deux phrases précises sur un instrument ou une technique que vous avez réellement vus.]",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* 6. Ouverture d'un dossier                                                  */
/* -------------------------------------------------------------------------- */

export async function openDossier(slug: string, loadWorkshop: WorkshopLoader) {
  const workshop = await loadWorkshop(slug);
  if (!workshop) throw new TransitionRefused(`Fiche introuvable : ${slug}`);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(prospectionDossiers)
      .where(eq(prospectionDossiers.slug, slug))
      .limit(1);
    if (existing) return existing;

    const state: ProspectionState = workshop.websiteUrl ? "opened" : "no_website";

    const [created] = await tx
      .insert(prospectionDossiers)
      .values({
        slug,
        workshopName: workshop.name.trim().slice(0, 200),
        websiteUrl: workshop.websiteUrl ?? null,
        state,
        lastReason: state === "no_website" ? "no_website" : null,
        closedAt: null,
      })
      .returning();

    await journal(tx, {
      dossierId: created.id,
      slug,
      event: "dossier_opened",
      stateAfter: state,
      reason: state === "no_website" ? "no_website" : null,
    });
    return created;
  });
}

/* -------------------------------------------------------------------------- */
/* 7. Préparation : lecture + cohérence                                       */
/* -------------------------------------------------------------------------- */

export interface PrepareOutcome {
  state: ProspectionState;
  signals: string[];
  reason?: ProspectionReason;
  /** Vrai si le refus est technique et mérite une nouvelle tentative. */
  retryable?: boolean;
  /** Message de refus tel que renvoyé par la passerelle, à des fins d'affichage. */
  refusalMessage?: string;
}

/**
 * Lit la page publique de l'atelier, applique le contrôle de cohérence, puis
 * enregistre l'accroche déterministe et l'adresse relevée.
 *
 * Ne rédige rien avec un modèle, n'envoie rien, ne met rien en file.
 */
export async function prepareDossier(
  dossierId: string,
  loadWorkshop: WorkshopLoader,
): Promise<PrepareOutcome> {
  const [dossier] = await db
    .select()
    .from(prospectionDossiers)
    .where(eq(prospectionDossiers.id, dossierId))
    .limit(1);
  if (!dossier) throw new TransitionRefused("Dossier introuvable");

  const eligible: ProspectionState[] = ["opened", "verified", "inconsistent"];
  if (!eligible.includes(dossier.state as ProspectionState)) {
    return { state: dossier.state as ProspectionState, signals: [], reason: "human_decision" };
  }

  if (await isOpposed(dossier.contactEmail)) {
    const updated = await transition(dossierId, {
      target: "opposed",
      reason: "opposition_active",
      skipOppositionCheck: true,
    });
    return { state: updated.state as ProspectionState, signals: [], reason: "opposition_active" };
  }

  const workshop = await loadWorkshop(dossier.slug);
  if (!workshop?.websiteUrl) {
    const updated = await transition(dossierId, { target: "no_website", reason: "no_website" });
    return { state: updated.state as ProspectionState, signals: [], reason: "no_website" };
  }

  // Une fiche corrigée redevient éligible à une nouvelle lecture.
  if (dossier.state === "inconsistent") {
    await transition(dossierId, { target: "opened", reason: "record_corrected" });
  }

  let page: Awaited<ReturnType<typeof readPublicPage>>;
  try {
    page = await readPublicPage(workshop.websiteUrl);
  } catch (error) {
    // Refus légitime : robots.txt ou réservation de fouille de données.
    if (error instanceof PageReadRefused) {
      const updated = await db.transaction(async (tx) => {
        const next = await transition(dossierId, {
          target: "inconsistent",
          reason: "read_refused",
          tx,
        });
        await journal(tx, {
          dossierId,
          slug: dossier.slug,
          event: "page_read",
          reason: "read_refused",
        });
        return next;
      });
      return {
        state: updated.state as ProspectionState,
        signals: [],
        reason: "read_refused",
        retryable: false,
        refusalMessage: error.message,
      };
    }

    // Indisponibilité technique : l'état ne change pas, on retentera.
    await db.transaction((tx) =>
      journal(tx, {
        dossierId,
        slug: dossier.slug,
        event: "page_read",
        reason: "gateway_unavailable",
      }),
    );
    return {
      state: dossier.state as ProspectionState,
      signals: [],
      reason: "gateway_unavailable",
      retryable: true,
    };
  }

  const pageText = page.texte ?? "";
  const result = checkCoherence(workshop, pageText);

  if (!result.accepted) {
    const updated = await db.transaction(async (tx) => {
      const next = await transition(dossierId, {
        target: "inconsistent",
        reason: result.reason,
        tx,
      });
      await journal(tx, {
        dossierId,
        slug: dossier.slug,
        event: "coherence_refused",
        reason: result.reason,
        measure: result.signals.length,
      });
      return next;
    });
    return {
      state: updated.state as ProspectionState,
      signals: result.signals,
      reason: result.reason,
    };
  }

  const email = dossier.contactEmail ?? extractContactEmail(pageText);
  if (email && (await isOpposed(email))) {
    const updated = await db.transaction(async (tx) => {
      await tx
        .update(prospectionDossiers)
        .set({ contactEmail: email })
        .where(eq(prospectionDossiers.id, dossierId));
      return transition(dossierId, {
        target: "opposed",
        reason: "opposition_active",
        skipOppositionCheck: true,
        tx,
      });
    });
    return {
      state: updated.state as ProspectionState,
      signals: result.signals,
      reason: "opposition_active",
    };
  }

  const signals = sanitiseSignals(result.signals);

  const updated = await db.transaction(async (tx) => {
    await tx
      .update(prospectionDossiers)
      .set({
        contactEmail: dossier.contactEmail ?? email,
        websiteUrl: page.url_finale ?? workshop.websiteUrl,
        hook: buildHookFromSignals(workshop),
        hookOrigin: "signals",
        verifiedSignals: signals,
      })
      .where(eq(prospectionDossiers.id, dossierId));

    const next = await transition(dossierId, {
      target: "verified",
      expectedState: "opened",
      tx,
    });

    await journal(tx, {
      dossierId,
      slug: dossier.slug,
      event: "coherence_accepted",
      measure: signals.length,
    });
    return next;
  });

  return { state: updated.state as ProspectionState, signals };
}
