import { randomUUID } from "node:crypto";
import { Sn13Client, type OnDemandDataResponse } from "macrocosmos";

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

export type DataUniverseRequest = {
  source: "X" | "Reddit";
  usernames: string[];
  keywords: string[];
  startDate: string;
  endDate: string;
  limit: number;
  keywordMode: "any" | "all";
};

export type Sn13CollectionStatus = "jamais" | "succes" | "vide" | "erreur";

export type Sn13CallState = {
  statut: Sn13CollectionStatus;
  requete_id: string | null;
  corps_erreur: string | null;
  appele_le: string | null;
  nombre: number | null;
};

export type DataUniverseRequestResult = {
  response: OnDemandDataResponse;
  requeteId: string;
  corpsErreur: string | null;
};

type Sn13ClientFactory = (apiKey: string) => Pick<Sn13Client, "onDemandData">;

const defaultSn13ClientFactory: Sn13ClientFactory = (apiKey) =>
  new Sn13Client({ apiKey });

let sn13ClientFactory = defaultSn13ClientFactory;

const initialSn13CallState: Sn13CallState = {
  statut: "jamais",
  requete_id: null,
  corps_erreur: null,
  appele_le: null,
  nombre: null,
};

let lastSn13CallState: Sn13CallState = initialSn13CallState;

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requestIdFromValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["request_id", "requestId", "request-id", "id"]) {
    const candidate = textValue(record[key]);
    if (candidate) return candidate.slice(0, 200);
  }
  return undefined;
}

function sn13RequestId(response: OnDemandDataResponse, fallback: string): string {
  return requestIdFromValue(response.meta) ?? fallback;
}

function sanitizedErrorBody(value: unknown, apiKey: string): string {
  let body: string;
  if (typeof value === "string") {
    body = value;
  } else {
    try {
      body = JSON.stringify(value) ?? String(value);
    } catch {
      body = String(value);
    }
  }
  const escapedApiKey = apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body
    .replace(new RegExp(escapedApiKey, "g"), "[REDACTED]")
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|authorization|token|secret)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      "$1[REDACTED]",
    )
    .slice(0, 4_000);
}

function errorBodyFromResponse(response: OnDemandDataResponse, apiKey: string): string {
  return sanitizedErrorBody(
    {
      status: response.status,
      data: response.data,
      meta: response.meta,
    },
    apiKey,
  );
}

function errorBodyFromThrown(error: unknown, apiKey: string): string {
  if (error instanceof Error) {
    return sanitizedErrorBody(`${error.name}: ${error.message}`, apiKey);
  }
  return sanitizedErrorBody(error, apiKey);
}

function rememberSn13Call(
  statut: Exclude<Sn13CollectionStatus, "jamais">,
  requeteId: string,
  nombre: number | null,
  corpsErreur: string | null,
) {
  lastSn13CallState = {
    statut,
    requete_id: requeteId,
    corps_erreur: corpsErreur,
    appele_le: new Date().toISOString(),
    nombre,
  };
}

export function lastSn13Call(): Sn13CallState {
  return { ...lastSn13CallState };
}

export function setSn13ClientFactoryForTests(factory: Sn13ClientFactory | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Le client SN13 ne peut être remplacé qu’en environnement de test.");
  }
  sn13ClientFactory = factory ?? defaultSn13ClientFactory;
}

export async function requestDataUniverse(
  request: DataUniverseRequest,
): Promise<DataUniverseRequestResult> {
  const apiKey = process.env.SN13_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("SN13_API_KEY non configurée");
  }
  const fallbackRequestId = randomUUID();
  const client = sn13ClientFactory(apiKey);
  try {
    const response = await client.onDemandData(request);
    const requeteId = sn13RequestId(response, fallbackRequestId);
    const isSuccess = response.status.toLowerCase() === "success";
    const nombre = isSuccess && Array.isArray(response.data) ? response.data.length : null;
    const corpsErreur = isSuccess ? null : errorBodyFromResponse(response, apiKey);
    rememberSn13Call(
      isSuccess ? (nombre === 0 ? "vide" : "succes") : "erreur",
      requeteId,
      nombre,
      corpsErreur,
    );
    return { response, requeteId, corpsErreur };
  } catch (error) {
    const requeteId = requestIdFromValue((error as { metadata?: unknown })?.metadata) ?? fallbackRequestId;
    const corpsErreur = errorBodyFromThrown(error, apiKey);
    rememberSn13Call("erreur", requeteId, null, corpsErreur);
    throw Object.assign(error instanceof Error ? error : new Error(corpsErreur), {
      sn13RequestId: requeteId,
      sn13ErrorBody: corpsErreur,
    });
  }
}

export function sn13ErrorBody(error: unknown): string | undefined {
  return textValue((error as { sn13ErrorBody?: unknown })?.sn13ErrorBody);
}

export function sn13ErrorFingerprint(errorBody: string): string {
  return errorBody.replace(
    /(["']?request[_-]?id["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
    "$1[REQUEST_ID]",
  );
}

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
        "https://constellation.api.cloud.macrocosmos.ai/sn13.v1.Sn13Service/OnDemandData",
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
        "Secours sans collecte distante : renvoie une liste vide avec un état explicite et ne publie jamais dans l’annuaire.",
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
