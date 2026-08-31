import { readFile } from "node:fs/promises";
import path from "node:path";
import { GetFicheResponse } from "@workspace/api-zod";
import { facetsForFiche } from "../lib/novaluth-facets";

const manualSource = "saisie manuelle";
const localCollectionFile = path.join("data", "luthiers-saisis.json");

type ManualCollectionDocument = {
  version: unknown;
  luthiers: unknown;
};

type Fiche = ReturnType<typeof GetFicheResponse.parse>;

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} doit être un objet JSON.`);
  }
  return value as Record<string, unknown>;
}

function sourceValues(value: unknown, index: number): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((source) => typeof source !== "string")
  ) {
    throw new Error(
      `luthiers[${index}].sources doit être un tableau de chaînes.`,
    );
  }
  return value.map((source) => source.trim()).filter(Boolean);
}

async function readLocalCollectionFile(): Promise<unknown> {
  const candidates = [
    path.resolve(process.cwd(), localCollectionFile),
    path.resolve(process.cwd(), "..", localCollectionFile),
    path.resolve(process.cwd(), "..", "..", localCollectionFile),
    path.resolve(process.cwd(), "..", "..", "..", localCollectionFile),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      lastError = error;
    }
  }
  throw new Error(`Fichier ${localCollectionFile} introuvable.`, {
    cause: lastError,
  });
}

function normalizeManualFiche(
  value: unknown,
  index: number,
  generatedAt: string,
): Fiche {
  const input = recordValue(value, `luthiers[${index}]`);
  if (
    typeof input.slug !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)
  ) {
    throw new Error(
      `luthiers[${index}].slug doit contenir uniquement des minuscules, chiffres et tirets.`,
    );
  }
  const sources = sourceValues(input.sources, index);
  const {
    sources: _ignoredSources,
    statut: _ignoredStatus,
    source_donnees: _ignoredDataSources,
    demonstration: _ignoredDemonstration,
    valide_par_artisan: _ignoredValidation,
    verification_identite_le: _ignoredIdentityVerification,
    cree_le: _ignoredCreatedAt,
    maj_le: _ignoredUpdatedAt,
    facons_travail: _ignoredFacets,
    provenance_facons: _ignoredFacetProvenance,
    ...manualData
  } = input;
  const parsed = GetFicheResponse.parse({
    ...manualData,
    statut: "candidate",
    source_donnees: [
      manualSource,
      ...sources.filter((source) => source !== manualSource),
    ],
    valide_par_artisan: false,
    verification_identite_le: null,
    demonstration: false,
    cree_le: generatedAt,
    maj_le: null,
    facons_travail: [],
    provenance_facons: manualSource,
    ia: input.ia ?? {
      tags: [],
      mots_cles: [],
      resume_ia: null,
      modele_utilise: manualSource,
      genere_le: null,
    },
  });
  return {
    ...parsed,
    facons_travail: facetsForFiche(parsed),
    provenance_facons: manualSource,
  };
}

export async function readLocalCollection(now = new Date()): Promise<Fiche[]> {
  const document = recordValue(await readLocalCollectionFile(), "document");
  const versioned = document as ManualCollectionDocument;
  if (versioned.version !== 1) {
    throw new Error("data/luthiers-saisis.json doit utiliser la version 1.");
  }
  if (!Array.isArray(versioned.luthiers)) {
    throw new Error("data/luthiers-saisis.json.luthiers doit être un tableau.");
  }
  const slugs = new Set<string>();
  return versioned.luthiers.map((entry, index) => {
    const fiche = normalizeManualFiche(entry, index, now.toISOString());
    if (slugs.has(fiche.slug)) {
      throw new Error(
        `Le slug ${fiche.slug} est dupliqué dans la collecte locale.`,
      );
    }
    slugs.add(fiche.slug);
    return fiche;
  });
}
