export type ProviderNeed = "inference" | "recherche" | "lecture" | "collecte";

export type ProviderDefinition = {
  key: string;
  name: string;
  network: "local" | "classique" | "bittensor";
  netuid: number | null;
  endpoint: string | null;
  apiKeyEnv: string | null;
  header: "bearer" | "x-api-key" | "authorization" | null;
  pricing: string;
  source: string;
  license: string;
  reservation: string;
  models: readonly string[];
};

const envOr = (name: string, fallback: string) =>
  process.env[name]?.trim() || fallback;

const inferenceModels = [
  envOr("CHUTES_MODEL", "Qwen/Qwen3-32B-TEE"),
  "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
] as const;

export const providerChains: Record<ProviderNeed, readonly ProviderDefinition[]> = {
  inference: [
    {
      key: "chutes",
      name: "Chutes AI",
      network: "bittensor",
      netuid: 64,
      endpoint: envOr(
        "CHUTES_API_URL",
        "https://llm.chutes.ai/v1/chat/completions",
      ),
      apiKeyEnv: "CHUTES_API_KEY",
      header: "bearer",
      pricing: "Selon la grille publique du fournisseur",
      source: "https://chutes.ai/",
      license: "Selon le modèle choisi",
      reservation: "La disponibilité et les conditions du modèle peuvent changer.",
      models: inferenceModels,
    },
    {
      key: "local-deterministe",
      name: "Moteur déterministe NovaLuth",
      network: "local",
      netuid: null,
      endpoint: null,
      apiKeyEnv: null,
      header: null,
      pricing: "Sans coût de fournisseur",
      source: "Registre public NovaLuth",
      license: "Code NovaLuth",
      reservation: "Pas d’envoi de données à un tiers.",
      models: ["local-deterministe"],
    },
  ],
  recherche: [
    {
      key: "desearch",
      name: "Desearch",
      network: "bittensor",
      netuid: 22,
      endpoint: envOr("DESEARCH_API_URL", "https://api.desearch.ai/search"),
      apiKeyEnv: "DESEARCH_API_KEY",
      header: "x-api-key",
      pricing: "0,10 $ pour 100 recherches, relevé du 27/08/2026",
      source: "https://desearch.ai/",
      license: "MIT annoncée pour le code du sous-réseau",
      reservation:
        "Les résultats servent uniquement à trouver des pages ; aucun extrait n’est republié.",
      models: [],
    },
    {
      key: "apex",
      name: "Apex",
      network: "classique",
      netuid: null,
      endpoint: envOr("APEX_API_URL", "https://api.apex.ai/v1/search"),
      apiKeyEnv: "APEX_API_KEY",
      header: "bearer",
      pricing: "Selon la grille publique du fournisseur",
      source: "https://apex.ai/",
      license: "Conditions du fournisseur",
      reservation: "Fournisseur de secours, activé seulement si configuré.",
      models: [],
    },
  ],
  lecture: [
    {
      key: "directe",
      name: "Lecture directe NovaLuth",
      network: "local",
      netuid: null,
      endpoint: null,
      apiKeyEnv: null,
      header: null,
      pricing: "Sans coût de fournisseur",
      source: "Registre public NovaLuth",
      license: "Code NovaLuth",
      reservation:
        "robots.txt, réservations TDM, domaines sociaux, taille et cadence respectés.",
      models: [],
    },
    {
      key: "desearch-page",
      name: "Desearch — lecture de secours",
      network: "bittensor",
      netuid: 22,
      endpoint: envOr("DESEARCH_PAGE_API_URL", "https://api.desearch.ai/page"),
      apiKeyEnv: "DESEARCH_API_KEY",
      header: "x-api-key",
      pricing: "Selon la grille publique du fournisseur",
      source: "https://desearch.ai/",
      license: "MIT annoncée pour le code du sous-réseau",
      reservation:
        "Jamais utilisé lorsque la lecture directe a reçu un refus juridique.",
      models: [],
    },
  ],
  collecte: [
    {
      key: "data-universe",
      name: "Data Universe",
      network: "bittensor",
      netuid: 13,
      endpoint: envOr(
        "SN13_API_URL",
        "https://api.datauniverse.ai/v1/publications",
      ),
      apiKeyEnv: "SN13_API_KEY",
      header: "bearer",
      pricing: "0,10 $ pour 1 000 publications, relevé du 27/08/2026",
      source: "https://github.com/macrocosm-os/data-universe",
      license: "MIT annoncée pour le code du sous-réseau",
      reservation:
        "X et Reddit uniquement ; les publications restent des signaux de découverte.",
      models: [],
    },
    {
      key: "local-collecte",
      name: "Collecte locale NovaLuth",
      network: "local",
      netuid: null,
      endpoint: null,
      apiKeyEnv: null,
      header: null,
      pricing: "Sans coût de fournisseur",
      source: "Registre public NovaLuth",
      license: "Code NovaLuth",
      reservation:
        "Secours sans collecte distante : renvoie une liste vide et ne publie jamais dans l’annuaire.",
      models: [],
    },
  ],
};

export const excludedProviders = ["desearch-social"] as const;

export function isProviderConfigured(provider: ProviderDefinition): boolean {
  return provider.apiKeyEnv === null || Boolean(process.env[provider.apiKeyEnv]?.trim());
}

export function activeProviders(need: ProviderNeed): ProviderDefinition[] {
  return providerChains[need].filter(
    (provider) =>
      !excludedProviders.includes(provider.key as (typeof excludedProviders)[number]) &&
      isProviderConfigured(provider),
  );
}

export function authorizedModels(): string[] {
  return [...new Set(providerChains.inference.flatMap((provider) => provider.models))];
}

export function providerHeaders(provider: ProviderDefinition): Record<string, string> {
  const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv]?.trim() : "";
  if (!key || !provider.header) {
    return { "Content-Type": "application/json" };
  }
  if (provider.header === "bearer") {
    return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  }
  if (provider.header === "x-api-key") {
    return { "X-API-KEY": key, "Content-Type": "application/json" };
  }
  return { Authorization: key, "Content-Type": "application/json" };
}

export function publicProvider(provider: ProviderDefinition) {
  return {
    cle: provider.key,
    nom: provider.name,
    reseau: provider.network,
    netuid: provider.netuid,
    tarif: provider.pricing,
    source: provider.source,
    licence: provider.license,
    reserve: provider.reservation,
    configure: isProviderConfigured(provider),
    modeles: provider.models,
  };
}

export function publicProviderState() {
  return {
    besoins: Object.fromEntries(
      Object.entries(providerChains).map(([need, providers]) => [
        need,
        providers.map(publicProvider),
      ]),
    ),
    hors_production: [...excludedProviders],
    principes: [
      "Les chaînes sont ordonnées par besoin et peuvent être remplacées sans modifier le matching public.",
      "Un identifiant de réseau est une information descriptive, jamais une dépendance de routage.",
      "La présence d’une clé est affichée, mais sa valeur n’est jamais exposée.",
    ],
    modeles_autorises: authorizedModels(),
  };
}
