export type DirectorySort = "equitable" | "delai" | "budget" | "alpha" | "maj";
type DirectoryFiche = {
  slug: string;
  nom: string;
  approche_artisanale?: string | null;
  production_annuelle?: number | null;
  prix_min_eur?: number | null;
  delai_moyen_mois?: number | null;
  valide_par_artisan?: boolean;
  maj_le?: string | null;
  facons_travail: string[];
  modeles: Array<{
    nom: string;
    type: string;
    inspiration?: string | null;
    personnalisable: boolean;
    specifications: {
      bois_corps?: string | null;
      bois_manche?: string | null;
      touche?: string | null;
      chevalet?: string | null;
      type_micros?: string | null;
      diapason_mm?: number | null;
    };
  }>;
  innovation: {
    materiaux_alternatifs?: string[];
    demarche_ecologique?: string | null;
    technologie_proprietaire?: string | null;
    edition_limitee?: boolean;
    marqueurs?: string[];
  };
  ia: {
    tags?: string[];
    mots_cles?: string[];
    resume_ia?: string | null;
  };
  profil_sonore: {
    styles?: string[];
    couleur?: string | null;
  };
  logistique: {
    expedie_france?: boolean;
    expedie_europe?: boolean;
    expedie_monde?: boolean;
  };
};
type DirectoryFilters = {
  query?: string;
  instrument?: string;
  style?: string;
  soundColour?: string;
  zone?: string;
  budget?: number;
  deadline?: number;
  reviewedOnly?: boolean;
  facets?: string[];
};

type FacetDefinition = {
  key: string;
  label: string;
  help: string;
  patterns?: string[];
  matches?: (fiche: DirectoryFiche) => boolean;
};

export const FACET_FAMILIES: ReadonlyArray<{
  key: string;
  title: string;
  choices: ReadonlyArray<FacetDefinition>;
}> = [
  {
    key: "matieres",
    title: "Matières et bois",
    choices: [
      { key: "essences_locales", label: "Essences locales", help: "Bois achetés à des scieries proches de l’atelier.", patterns: ["essences locales", "bois locaux", "bois local", "circuit court", "essences francaises", "bois francais"] },
      { key: "bois_reemploi", label: "Bois de réemploi", help: "Bois récupérés : anciennes charpentes, mobilier ou chutes d’ébénisterie.", patterns: ["bois de reemploi", "reemploi", "bois recycle", "recuperation", "bois de recuperation", "seconde vie"] },
      { key: "biosource", label: "Matières biosourcées", help: "Lin, chanvre ou résines végétales en remplacement de matériaux pétroliers.", patterns: ["biosource", "lin", "chanvre", "resine vegetale"] },
      { key: "composite", label: "Carbone ou composite", help: "Structure ou renforts en matériaux techniques.", patterns: ["carbone", "composite", "fibre de verre"] },
      { key: "bois_thermotraite", label: "Bois thermotraité", help: "Bois chauffé pour le stabiliser, sans traitement chimique.", patterns: ["thermotraite", "thermo traite", "torrefie", "thermochauffe"] },
      { key: "sans_essence_protegee", label: "Aucune essence protégée", help: "L’atelier déclare n’employer aucune essence menacée ou soumise à la CITES.", patterns: ["aucune essence protegee", "sans essence protegee", "hors cites", "aucune essence menacee", "sans essence menacee"] },
    ],
  },
  {
    key: "construction",
    title: "Construction",
    choices: [
      { key: "sans_tete", label: "Sans tête (headless)", help: "Mécaniques déplacées au chevalet, instrument plus court et plus léger.", patterns: ["headless", "sans tete"] },
      { key: "multidiapason", label: "Multi-diapason (multiscale)", help: "Frettes en éventail et longueur de corde adaptée.", patterns: ["multiscale", "multi diapason", "multidiapason", "fan fret", "frettes en eventail", "diapason multiple"] },
      { key: "table_voutee", label: "Table voûtée ou sculptée", help: "Table travaillée dans l’épaisseur : archtop, table bombée ou sculptée.", patterns: ["archtop", "table voutee", "table sculptee", "table bombee", "table barree en eventail"] },
      { key: "modulaire", label: "Modulaire ou évolutif", help: "Éléments démontables ou remplaçables, comme les micros ou l’électronique.", patterns: ["modulaire", "interchangeable", "evolutif"] },
      { key: "diapason_court", label: "Diapason court", help: "Longueur de corde réduite pour un jeu plus souple.", patterns: ["diapason court", "short scale"], matches: (fiche) => fiche.modeles.some((model) => model.specifications.diapason_mm != null && (model.type === "basse" ? model.specifications.diapason_mm <= 815 : model.specifications.diapason_mm <= 630)) },
      { key: "sans_frette", label: "Sans frette", help: "Touche lisse, fréquente sur les basses.", patterns: ["fretless", "sans frette"] },
      { key: "reparable", label: "Pensé pour être réparé", help: "Pièces d’usure remplaçables, plans ou références disponibles.", patterns: ["reparable", "reparabilite", "pieces detachees", "demontable"] },
    ],
  },
  {
    key: "maniere",
    title: "Manière de travailler",
    choices: [
      { key: "atelier_une_personne", label: "Atelier d’une seule personne", help: "Un artisan fait tout, de la découpe au réglage final.", patterns: ["atelier d'une personne", "seul artisan", "travaille seul", "une seule personne", "atelier individuel"] },
      { key: "petite_production", label: "Vingt instruments par an au plus", help: "Production déclarée très réduite, chaque instrument reste suivi.", matches: (fiche) => fiche.production_annuelle != null && fiche.production_annuelle <= 20 },
      { key: "tout_a_la_commande", label: "Uniquement sur commande", help: "L’instrument démarre après votre accord.", patterns: ["tout a la commande", "sur commande", "a la commande", "sur mesure uniquement"] },
      { key: "personnalisation_complete", label: "Personnalisation acceptée", help: "Bois, dimensions, électronique ou finition modifiables sur au moins un modèle.", patterns: ["personnalisation", "sur mesure"], matches: (fiche) => fiche.modeles.some((model) => model.personnalisable) },
      { key: "serie_limitee", label: "Série limitée", help: "Nombre d’exemplaires annoncé à l’avance.", matches: (fiche) => Boolean(fiche.innovation.edition_limitee) },
    ],
  },
  {
    key: "finition",
    title: "Finition",
    choices: [
      { key: "huile_cire", label: "Finition huile-cire", help: "Finition fine et réparable localement, sans film plastique.", patterns: ["huile cire", "huile-cire", "finition a l'huile", "cire d'abeille"] },
      { key: "vernis_traditionnel", label: "Vernis traditionnel", help: "Gomme-laque au tampon ou nitrocellulose, film mince et retouchable.", patterns: ["gomme laque", "gomme-laque", "nitrocellulose", "nitro", "vernis au tampon", "vernis a l'alcool"] },
      { key: "finition_brute", label: "Bois laissé brut ou satiné", help: "Aucun film brillant, le toucher du bois est conservé.", patterns: ["brut", "brute", "satine", "satinee", "mat", "mate", "sans vernis", "non verni", "finition naturelle"] },
    ],
  },
];

const allFacets = FACET_FAMILIES.flatMap((family) => family.choices);
const facetsByKey = new Map(allFacets.map((facet) => [facet.key, facet]));

function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("fr");
}

function hasWholePhrase(text: string, phrase: string) {
  const escaped = normalize(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`, "u").test(text);
}

function declaredText(fiche: DirectoryFiche) {
  const parts = [
    fiche.approche_artisanale,
    fiche.innovation.demarche_ecologique,
    fiche.innovation.technologie_proprietaire,
    ...(fiche.innovation.materiaux_alternatifs ?? []),
    ...(fiche.innovation.marqueurs ?? []),
    ...(fiche.ia.tags ?? []),
    ...(fiche.ia.mots_cles ?? []),
    ...fiche.modeles.flatMap((model) => [
      model.nom,
      model.inspiration,
      model.specifications.bois_corps,
      model.specifications.bois_manche,
      model.specifications.touche,
      model.specifications.chevalet,
      model.specifications.type_micros,
    ]),
  ].filter((value): value is string => Boolean(value));
  return normalize(parts.join(" · "));
}

export function normalizeFacetKeys(values: Iterable<string>) {
  const wanted = new Set([...values].map((value) => value.trim()).filter(Boolean));
  return allFacets.map((facet) => facet.key).filter((key) => wanted.has(key));
}

export function facetLabel(key: string) {
  return facetsByKey.get(key)?.label ?? key;
}

export function facetsForFiche(fiche: DirectoryFiche) {
  const text = declaredText(fiche);
  return allFacets
    .filter((facet) => (facet.patterns?.some((pattern) => hasWholePhrase(text, pattern)) ?? false) || facet.matches?.(fiche))
    .map((facet) => facet.key);
}

export function facetProvenance(fiche: DirectoryFiche) {
  return fiche.valide_par_artisan ? "relu par l’artisan" : "d’après ses pages publiques";
}

export function availableFacetFamilies(fiches: DirectoryFiche[]) {
  const present = new Set(fiches.flatMap((fiche) => fiche.facons_travail));
  return FACET_FAMILIES.map((family) => ({
    cle: family.key,
    titre: family.title,
    cases: family.choices
      .filter((choice) => present.has(choice.key))
      .map((choice) => ({ cle: choice.key, libelle: choice.label, aide: choice.help })),
  })).filter((family) => family.cases.length > 0);
}

export function availableStyles(fiches: DirectoryFiche[]) {
  const counts = new Map<string, number>();
  for (const fiche of fiches) {
    for (const style of fiche.profil_sonore.styles ?? []) {
      const key = style.trim().toLocaleLowerCase("fr");
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort(([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || leftName.localeCompare(rightName, "fr"))
    .map(([style]) => style);
}

export function filterDirectory(fiches: DirectoryFiche[], filters: DirectoryFilters) {
  const normalizedQuery = filters.query ? normalize(filters.query.trim()) : "";
  return fiches.filter((fiche) => {
    const haystack = normalize([fiche.nom, fiche.approche_artisanale, fiche.ia.resume_ia, ...(fiche.ia.tags ?? []), ...(fiche.ia.mots_cles ?? [])].filter(Boolean).join(" "));
    if (normalizedQuery && !haystack.includes(normalizedQuery)) return false;
    if (filters.instrument && fiche.modeles.length && !fiche.modeles.some((model) => model.type === filters.instrument)) return false;
    if (filters.style && (fiche.profil_sonore.styles?.length ?? 0) > 0 && !fiche.profil_sonore.styles?.some((style) => normalize(style).includes(normalize(filters.style!)))) return false;
    if (filters.soundColour && fiche.profil_sonore.couleur != null && fiche.profil_sonore.couleur !== filters.soundColour) return false;
    if (filters.zone) {
      const shipment = { france: fiche.logistique.expedie_france, europe: fiche.logistique.expedie_europe, monde: fiche.logistique.expedie_monde };
      if (shipment[filters.zone as keyof typeof shipment] === false) return false;
    }
    if (filters.budget != null && fiche.prix_min_eur != null && fiche.prix_min_eur > filters.budget) return false;
    if (filters.deadline != null && fiche.delai_moyen_mois != null && fiche.delai_moyen_mois > filters.deadline) return false;
    if (filters.reviewedOnly && !fiche.valide_par_artisan) return false;
    if (filters.facets?.length && !filters.facets.every((facet) => fiche.facons_travail.includes(facet))) return false;
    return true;
  });
}

function seedFromDate(day: string) {
  return [...day].reduce((seed, character) => ((seed << 5) - seed + character.charCodeAt(0)) | 0, 0) >>> 0;
}

function randomFrom(seed: number) {
  let value = seed;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function sortDirectory(fiches: DirectoryFiche[], sort: DirectorySort = "equitable") {
  const ordered = [...fiches].sort((left, right) => left.slug.localeCompare(right.slug));
  const random = randomFrom(seedFromDate(new Date().toISOString().slice(0, 10)));
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [ordered[index], ordered[other]] = [ordered[other], ordered[index]];
  }
  if (sort === "delai") return ordered.sort((left, right) => (left.delai_moyen_mois ?? 10_000) - (right.delai_moyen_mois ?? 10_000));
  if (sort === "budget") return ordered.sort((left, right) => (left.prix_min_eur ?? 10_000_000) - (right.prix_min_eur ?? 10_000_000));
  if (sort === "alpha") return ordered.sort((left, right) => left.nom.localeCompare(right.nom, "fr"));
  if (sort === "maj") return ordered.sort((left, right) => (right.maj_le ?? "").localeCompare(left.maj_le ?? ""));
  return ordered;
}