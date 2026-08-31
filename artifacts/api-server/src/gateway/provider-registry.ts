import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Sn13Client, type OnDemandDataResponse } from "macrocosmos";
import {
  db,
  novaluthSn13AlertStateTable,
  novaluthSn13CallEventsTable,
  novaluthSn13DiagnosticsTable,
} from "@workspace/db";
import { enqueueNovaLuthEmail } from "../lib/novaluth-email-outbox";

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

export type Sn13CollectionStatus =
  "jamais" | "succes" | "vide" | "incomplet" | "erreur";

export type Sn13RecentStats = {
  fenetre_heures: number;
  total: number;
  succes: number;
  vide: number;
  incomplet: number;
  erreur: number;
  alerte: boolean;
};

export type Sn13CallState = {
  statut: Sn13CollectionStatus;
  requete_id: string | null;
  corps_erreur: string | null;
  appele_le: string | null;
  nombre: number | null;
  recents: Sn13RecentStats;
};

export type Sn13PurgeMaintenanceStatus = "succes" | "erreur";

export type Sn13PurgeMaintenanceResult = {
  statut: Sn13PurgeMaintenanceStatus;
  evenements_supprimes: number;
  retabli: boolean;
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
let sn13Now = () => Date.now();

const initialSn13CallState: Sn13CallState = {
  statut: "jamais",
  requete_id: null,
  corps_erreur: null,
  appele_le: null,
  nombre: null,
  recents: {
    fenetre_heures: 24,
    total: 0,
    succes: 0,
    vide: 0,
    incomplet: 0,
    erreur: 0,
    alerte: false,
  },
};

const sn13RecentWindowMs = 24 * 60 * 60 * 1_000;
const sn13IncompleteAlertThreshold = 2;
const sn13RecentHistory: Array<{
  at: number;
  statut: Exclude<Sn13CollectionStatus, "jamais">;
}> = [];
let lastSn13CallState: Sn13CallState = initialSn13CallState;

const SN13_DIAGNOSTIC_KEY = "latest";
const MAX_SN13_ERROR_BODY_LENGTH = 4_000;
const SN13_ALERT_DEDUPE_PREFIX = "sn13:degradation";
const SN13_ALERT_STATE_KEY = "latest";
const SN13_ALERT_LOCK_KEY = "novaluth:sn13:alert";
const SN13_PURGE_ALERT_DEDUPE_PREFIX = "sn13:purge-failure";
const SN13_PURGE_ALERT_STATE_KEY = "purge";
const SN13_PURGE_ALERT_LOCK_KEY = "novaluth:sn13:purge-alert";
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

function sn13RequestId(
  response: OnDemandDataResponse,
  fallback: string,
): string {
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
    .slice(0, MAX_SN13_ERROR_BODY_LENGTH);
}

function errorBodyFromResponse(
  response: OnDemandDataResponse,
  apiKey: string,
): string {
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

function recentSn13Stats(now = Date.now()): Sn13RecentStats {
  const cutoff = now - sn13RecentWindowMs;
  while (sn13RecentHistory[0]?.at < cutoff) sn13RecentHistory.shift();

  const stats = {
    succes: 0,
    vide: 0,
    incomplet: 0,
    erreur: 0,
  };
  for (const entry of sn13RecentHistory) stats[entry.statut] += 1;
  return {
    fenetre_heures: 24,
    total: sn13RecentHistory.length,
    ...stats,
    alerte: stats.incomplet >= sn13IncompleteAlertThreshold,
  };
}

async function persistedRecentSn13Stats(
  now = Date.now(),
): Promise<Sn13RecentStats> {
  const cutoffDate = new Date(now - sn13RecentWindowMs);
  const recentResult = await db.execute(sql`
    select
      count(*)::int as total,
      count(*) filter (where status = 'succes')::int as succes,
      count(*) filter (where status = 'vide')::int as vide,
      count(*) filter (where status = 'incomplet')::int as incomplet,
      count(*) filter (where status = 'erreur')::int as erreur
    from novaluth_sn13_call_events
    where called_at >= ${cutoffDate}
  `);
  const recent = recentResult.rows[0] as {
    total: number;
    succes: number;
    vide: number;
    incomplet: number;
    erreur: number;
  };
  return {
    fenetre_heures: 24,
    total: recent.total,
    succes: recent.succes,
    vide: recent.vide,
    incomplet: recent.incomplet,
    erreur: recent.erreur,
    alerte: recent.incomplet >= sn13IncompleteAlertThreshold,
  };
}

export async function purgeExpiredSn13CallEvents(
  now = Date.now(),
): Promise<number> {
  const cutoffDate = new Date(now - sn13RecentWindowMs);
  const deleted = await db
    .delete(novaluthSn13CallEventsTable)
    .where(sql`${novaluthSn13CallEventsTable.calledAt} < ${cutoffDate}`)
    .returning({ id: novaluthSn13CallEventsTable.id });
  return deleted.length;
}

async function updateSn13PurgeAlertState(
  active: boolean,
  now: number,
): Promise<{ transitioned: boolean; episodeStartedAt: Date | null }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${SN13_PURGE_ALERT_LOCK_KEY}))`,
    );
    await tx
      .insert(novaluthSn13AlertStateTable)
      .values({ key: SN13_PURGE_ALERT_STATE_KEY, active: false })
      .onConflictDoNothing({ target: novaluthSn13AlertStateTable.key });

    const stateResult = await tx.execute(sql`
      select
        active,
        episode_started_at as "episodeStartedAt"
      from novaluth_sn13_alert_state
      where key = ${SN13_PURGE_ALERT_STATE_KEY}
      for update
    `);
    const state = stateResult.rows[0] as
      { active: boolean; episodeStartedAt: Date | string | null } | undefined;
    if (!state)
      throw new Error("L’état d’alerte de purge SN13 est introuvable.");

    if (active) {
      if (state.active) {
        return {
          transitioned: false,
          episodeStartedAt: state.episodeStartedAt
            ? new Date(state.episodeStartedAt)
            : null,
        };
      }

      const episodeStartedAt = new Date(now);
      await tx
        .update(novaluthSn13AlertStateTable)
        .set({
          active: true,
          episodeStartedAt,
          updatedAt: episodeStartedAt,
        })
        .where(eq(novaluthSn13AlertStateTable.key, SN13_PURGE_ALERT_STATE_KEY));

      const recipient =
        process.env.NOVALUTH_SN13_ALERT_EMAIL?.trim() ||
        process.env.NOVALUTH_ALERT_EMAIL?.trim();
      if (recipient) {
        await enqueueNovaLuthEmail(
          tx,
          recipient,
          {
            event: "sn13_purge_failure",
            reference: "SN13",
            portalUrl: "",
            sn13Purge: {
              provider: "Data Universe",
              windowHours: 24,
            },
          },
          `${SN13_PURGE_ALERT_DEDUPE_PREFIX}:${episodeStartedAt.getTime()}`,
        );
      }
      return { transitioned: true, episodeStartedAt };
    }

    if (!state.active) {
      return {
        transitioned: false,
        episodeStartedAt: null,
      };
    }

    await tx
      .update(novaluthSn13AlertStateTable)
      .set({
        active: false,
        episodeStartedAt: null,
        updatedAt: new Date(now),
      })
      .where(eq(novaluthSn13AlertStateTable.key, SN13_PURGE_ALERT_STATE_KEY));
    return { transitioned: true, episodeStartedAt: null };
  });
}

export async function recordSn13PurgeFailure(
  now = Date.now(),
): Promise<boolean> {
  const result = await updateSn13PurgeAlertState(true, now);
  return result.transitioned;
}

export async function recordSn13PurgeSuccess(
  now = Date.now(),
): Promise<boolean> {
  const result = await updateSn13PurgeAlertState(false, now);
  return result.transitioned;
}

async function rememberSn13Call(
  statut: Exclude<Sn13CollectionStatus, "jamais">,
  requeteId: string,
  nombre: number | null,
  corpsErreur: string | null,
) {
  const calledAt = sn13Now();
  sn13RecentHistory.push({ at: calledAt, statut });
  const recentStats = recentSn13Stats(calledAt);
  const state: Sn13CallState = {
    statut,
    requete_id: requeteId,
    corps_erreur: corpsErreur,
    appele_le: new Date(calledAt).toISOString(),
    nombre,
    recents: recentStats,
  };
  const calledAtDate = new Date(calledAt);
  const persisted = await db.transaction(async (tx) => {
    // The in-memory history above is useful for the local diagnostics response,
    // but it cannot decide an alert episode when several server processes run.
    // Serialize the shared window and episode transition in PostgreSQL.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${SN13_ALERT_LOCK_KEY}))`,
    );

    const [diagnostic] = await tx
      .insert(novaluthSn13DiagnosticsTable)
      .values({
        key: SN13_DIAGNOSTIC_KEY,
        status: state.statut,
        requestId: state.requete_id,
        errorBody: state.corps_erreur,
        calledAt: calledAtDate,
        resultCount: state.nombre,
      })
      .onConflictDoUpdate({
        target: novaluthSn13DiagnosticsTable.key,
        set: {
          status: state.statut,
          requestId: state.requete_id,
          errorBody: state.corps_erreur,
          calledAt: calledAtDate,
          resultCount: state.nombre,
        },
        // Collection completion can be committed out of order across processes.
        // Keep the newest completion, using the request id as a deterministic
        // tie-breaker when two clocks have the same millisecond.
        where: sql`
          ${novaluthSn13DiagnosticsTable.calledAt} < excluded.called_at
          OR (
            ${novaluthSn13DiagnosticsTable.calledAt} = excluded.called_at
            AND coalesce(${novaluthSn13DiagnosticsTable.requestId}, '') <
              coalesce(excluded.request_id, '')
          )
        `,
      })
      .returning({ key: novaluthSn13DiagnosticsTable.key });

    await tx.insert(novaluthSn13CallEventsTable).values({
      status: state.statut,
      calledAt: calledAtDate,
    });
    const cutoffDate = new Date(calledAt - sn13RecentWindowMs);
    await tx
      .delete(novaluthSn13CallEventsTable)
      .where(sql`${novaluthSn13CallEventsTable.calledAt} < ${cutoffDate}`);
    const recentResult = await tx.execute(sql`
      select
        count(*)::int as total,
        count(*) filter (where status = 'succes')::int as succes,
        count(*) filter (where status = 'vide')::int as vide,
        count(*) filter (where status = 'incomplet')::int as incomplet,
        count(*) filter (where status = 'erreur')::int as erreur
      from novaluth_sn13_call_events
      where called_at >= ${cutoffDate}
    `);
    const recent = recentResult.rows[0] as {
      total: number;
      succes: number;
      vide: number;
      incomplet: number;
      erreur: number;
    };
    const thresholdReached = recent.incomplet >= sn13IncompleteAlertThreshold;

    await tx
      .insert(novaluthSn13AlertStateTable)
      .values({ key: SN13_ALERT_STATE_KEY, active: false })
      .onConflictDoNothing({ target: novaluthSn13AlertStateTable.key });
    const alertStateResult = await tx.execute(sql`
      select
        active,
        episode_started_at as "episodeStartedAt"
      from novaluth_sn13_alert_state
      where key = ${SN13_ALERT_STATE_KEY}
      for update
    `);
    const alertState = alertStateResult.rows[0] as
      { active: boolean; episodeStartedAt: Date | string | null } | undefined;
    if (!alertState) throw new Error("L’état d’alerte SN13 est introuvable.");

    const crossedAlertThreshold = thresholdReached && !alertState.active;
    const episodeStartedAt = crossedAlertThreshold
      ? calledAtDate
      : alertState.episodeStartedAt
        ? new Date(alertState.episodeStartedAt)
        : null;
    if (thresholdReached) {
      await tx
        .update(novaluthSn13AlertStateTable)
        .set({
          active: true,
          episodeStartedAt,
          updatedAt: new Date(),
        })
        .where(eq(novaluthSn13AlertStateTable.key, SN13_ALERT_STATE_KEY));
    } else if (alertState.active) {
      await tx
        .update(novaluthSn13AlertStateTable)
        .set({
          active: false,
          episodeStartedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(novaluthSn13AlertStateTable.key, SN13_ALERT_STATE_KEY));
    }

    const recipient =
      process.env.NOVALUTH_SN13_ALERT_EMAIL?.trim() ||
      process.env.NOVALUTH_ALERT_EMAIL?.trim();
    if (crossedAlertThreshold && recipient && episodeStartedAt !== null) {
      await enqueueNovaLuthEmail(
        tx,
        recipient,
        {
          event: "sn13_degradation",
          reference: "SN13",
          portalUrl: "",
          sn13: {
            provider: "Data Universe",
            windowHours: 24,
            total: recent.total,
            success: recent.succes,
            empty: recent.vide,
            incomplete: recent.incomplet,
            error: recent.erreur,
          },
        },
        `${SN13_ALERT_DEDUPE_PREFIX}:${episodeStartedAt.getTime()}`,
      );
    }
    return Boolean(diagnostic);
  });
  if (persisted) {
    lastSn13CallState = state;
  }
}

export async function lastSn13Call(): Promise<Sn13CallState> {
  const recents = await persistedRecentSn13Stats();
  const [stored] = await db
    .select()
    .from(novaluthSn13DiagnosticsTable)
    .where(eq(novaluthSn13DiagnosticsTable.key, SN13_DIAGNOSTIC_KEY))
    .limit(1);
  if (!stored) {
    return { ...lastSn13CallState, recents };
  }
  return {
    statut: stored.status as Sn13CollectionStatus,
    requete_id: stored.requestId,
    corps_erreur: stored.errorBody,
    appele_le: stored.calledAt.toISOString(),
    nombre: stored.resultCount,
    recents,
  };
}

export function setSn13ClientFactoryForTests(
  factory: Sn13ClientFactory | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Le client SN13 ne peut être remplacé qu’en environnement de test.",
    );
  }
  sn13ClientFactory = factory ?? defaultSn13ClientFactory;
}

export function setSn13ClockForTests(clock: (() => number) | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "L’horloge SN13 ne peut être remplacée qu’en environnement de test.",
    );
  }
  sn13Now = clock ?? (() => Date.now());
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
    const hasUsableData = Array.isArray(response.data);
    const nombre = isSuccess && hasUsableData ? response.data.length : null;
    const corpsErreur =
      isSuccess && hasUsableData
        ? null
        : errorBodyFromResponse(response, apiKey);
    await rememberSn13Call(
      isSuccess
        ? hasUsableData
          ? nombre === 0
            ? "vide"
            : "succes"
          : "incomplet"
        : "erreur",
      requeteId,
      nombre,
      corpsErreur,
    );
    return { response, requeteId, corpsErreur };
  } catch (error) {
    const requeteId =
      requestIdFromValue((error as { metadata?: unknown })?.metadata) ??
      fallbackRequestId;
    const corpsErreur = errorBodyFromThrown(error, apiKey);
    await rememberSn13Call("erreur", requeteId, null, corpsErreur);
    throw Object.assign(
      error instanceof Error ? error : new Error(corpsErreur),
      {
        sn13RequestId: requeteId,
        sn13ErrorBody: corpsErreur,
      },
    );
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

export const providerChains: Record<
  ProviderNeed,
  readonly ProviderDefinition[]
> = {
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
      reservation:
        "La disponibilité et les conditions du modèle peuvent changer.",
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
  return (
    provider.apiKeyEnv === null ||
    Boolean(process.env[provider.apiKeyEnv]?.trim())
  );
}

export function activeProviders(need: ProviderNeed): ProviderDefinition[] {
  return providerChains[need].filter(
    (provider) =>
      !excludedProviders.includes(
        provider.key as (typeof excludedProviders)[number],
      ) && isProviderConfigured(provider),
  );
}

export function authorizedModels(): string[] {
  return [
    ...new Set(providerChains.inference.flatMap((provider) => provider.models)),
  ];
}

export function providerHeaders(
  provider: ProviderDefinition,
): Record<string, string> {
  const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv]?.trim() : "";
  if (!key || !provider.header) {
    return { "Content-Type": "application/json" };
  }
  if (provider.header === "bearer") {
    return {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
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
