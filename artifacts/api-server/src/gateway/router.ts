import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { anonymize } from "./anonymize";
import {
  activeProviders,
  authorizedModels,
  isProviderConfigured,
  providerChains,
  providerHeaders,
  publicProviderState,
  type ProviderDefinition,
} from "./provider-registry";
import { authenticateGatewayRequest, GatewayAuthError, gatewayIsConfigured } from "./auth";
import { PageReadRefused, readPublicPage, urlForExternalPageFallback } from "./page-harvester";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const limits = {
  ia: Number(process.env.NOVALUTH_LIMIT_IA_PER_DAY ?? 250),
  recherche: Number(process.env.NOVALUTH_LIMIT_SEARCH_PER_DAY ?? 100),
  page: Number(process.env.NOVALUTH_LIMIT_PAGE_PER_DAY ?? 100),
  collecte: Number(process.env.NOVALUTH_LIMIT_COLLECTION_PER_DAY ?? 50),
};

function publicHealth() {
  return {
    service: "novaluth-passerelle",
    secret_interne: gatewayIsConfigured(),
    cles_presentes: Object.fromEntries(
      Object.values(providerChains)
        .flat()
        .filter((provider) => provider.apiKeyEnv)
        .map((provider) => [provider.key, isProviderConfigured(provider)]),
    ),
    chaines_actives: Object.fromEntries(
      Object.keys(providerChains).map((need) => [
        need,
        activeProviders(need as keyof typeof providerChains).map((provider) => provider.key),
      ]),
    ),
    modeles_autorises: authorizedModels(),
    plafonds: {
      ia_par_jour: limits.ia,
      collecte_par_jour: limits.collecte,
      recherches_par_jour: limits.recherche,
      pages_par_jour: limits.page,
    },
  };
}

async function takeQuota(operation: keyof typeof limits): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const result = await db.execute<{ count: number }>(sql`
    insert into novaluth_gateway_daily_quotas (day, operation, count, updated_at)
    values (${day}, ${operation}, 1, now())
    on conflict (day, operation) do update
      set count = novaluth_gateway_daily_quotas.count + 1, updated_at = now()
      where novaluth_gateway_daily_quotas.count < ${limits[operation]}
    returning count
  `);
  const count = result.rows[0]?.count;
  if (count === undefined) {
    throw new GatewayAuthError(429, `Plafond quotidien atteint pour ${operation}.`);
  }
  return count;
}

function audit(
  caller: string,
  operation: string,
  target: string,
  status: number,
  extra: Record<string, unknown> = {},
) {
  logger.info(
    {
      passerelle: true,
      appelant: caller,
      operation,
      cible: target,
      statut: status,
      ...extra,
    },
    "NovaLuth gateway audit",
  );
}

function sendError(res: Response, error: unknown) {
  if (error instanceof GatewayAuthError || error instanceof PageReadRefused) {
    res.status(error instanceof PageReadRefused ? 200 : error.statusCode).json({
      erreur: error.message,
    });
    return;
  }
  logger.warn({ err: error }, "NovaLuth gateway request failed");
  res.status(502).json({ erreur: "La passerelle n’a pas pu terminer la demande." });
}

function body(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new GatewayAuthError(422, "Demande JSON invalide.");
  }
  return req.body as Record<string, unknown>;
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > max) {
    throw new GatewayAuthError(422, `${name} invalide.`);
  }
  return value.trim();
}

function optionalText(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, "champ texte", max);
}

async function providerRequest(
  provider: ProviderDefinition,
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
) {
  if (!provider.endpoint) throw new Error("provider sans endpoint");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(provider.endpoint, {
      method: "POST",
      headers: providerHeaders(provider),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSearchResults(data: unknown): { url: string; titre: string }[] {
  const candidates =
    (Array.isArray(data) && data) ||
    (data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)
      ? (data as { results: unknown[] }).results
      : data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)
        ? (data as { data: unknown[] }).data
        : []);
  const results: { url: string; titre: string }[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>;
    const rawUrl = row.url ?? row.link ?? row.href;
    if (typeof rawUrl !== "string") continue;
    try {
      const parsed = new URL(rawUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
      results.push({
        url: parsed.toString(),
        titre: typeof row.title === "string" ? row.title.slice(0, 200) : "",
      });
    } catch {
      continue;
    }
  }
  return results.slice(0, 30);
}

router.get("/sante", (_req, res) => res.json(publicHealth()));
router.get("/v1/etat", (_req, res) => res.json(publicProviderState()));

router.post("/v1/recherche", async (req, res) => {
  let caller = "inconnu";
  try {
    ({ caller } = await authenticateGatewayRequest(req));
    const input = body(req);
    const query = requiredText(input.requete, "requete", 300);
    const limit = input.limite === undefined ? 10 : Number(input.limite);
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
      throw new GatewayAuthError(422, "limite invalide.");
    }
    await takeQuota("recherche");
    const safeQuery = anonymize(query);
    if (safeQuery.removed > 0) {
      throw new GatewayAuthError(422, "La recherche contient des données personnelles ou sensibles.");
    }
    const providers = activeProviders("recherche");
    if (!providers.length) throw new GatewayAuthError(503, "Aucun fournisseur de recherche configuré.");
    const failures: string[] = [];
    for (const provider of providers) {
      try {
        const response = await providerRequest(provider, {
          query: safeQuery.text,
          requete: safeQuery.text,
          limit,
          n_results: limit,
        });
        if (!response.ok) {
          failures.push(provider.key);
          audit(caller, "recherche", provider.key, response.status);
          continue;
        }
        const results = normalizeSearchResults(await response.json());
        audit(caller, "recherche", provider.key, 200, {
          nombre: results.length,
          secours: failures.length,
          pii_retirees: safeQuery.removed,
        });
        res.json({
          resultats: results.slice(0, limit),
          nombre: Math.min(results.length, limit),
          fournisseur: provider.key,
          secours: failures,
        });
        return;
      } catch {
        failures.push(provider.key);
        audit(caller, "recherche", provider.key, 502);
      }
    }
    res.status(502).json({ erreur: "Aucun fournisseur de recherche n’a répondu.", fournisseurs: failures });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/v1/page", async (req, res) => {
  let caller = "inconnu";
  try {
    ({ caller } = await authenticateGatewayRequest(req));
    const input = body(req);
    const url = requiredText(input.url, "url", 2000);
    await takeQuota("page");
    const failures: string[] = [];
    for (const provider of activeProviders("lecture")) {
      try {
        if (provider.key === "directe") {
          const result = await readPublicPage(url);
          audit(caller, "page", provider.key, 200, { octets: result.octets, secours: failures.length });
          res.json({ ...result, lue: true, fournisseur: provider.key, secours: failures });
          return;
        }
        const providerUrl = urlForExternalPageFallback(url);
        const response = await providerRequest(provider, { url: providerUrl });
        if (!response.ok) {
          failures.push(provider.key);
          audit(caller, "page", provider.key, response.status);
          continue;
        }
        const data = (await response.json()) as Record<string, unknown>;
        const texte = typeof data.texte === "string" ? data.texte.slice(0, 12_000) : "";
        if (!texte) {
          failures.push(provider.key);
          audit(caller, "page", provider.key, 502);
          continue;
        }
        audit(caller, "page", provider.key, 200, { octets: texte.length, secours: failures.length });
        res.json({
          lue: true,
          fournisseur: provider.key,
          secours: failures,
          url: providerUrl,
          url_finale: typeof data.url_finale === "string" ? data.url_finale : providerUrl,
          titre: typeof data.titre === "string" ? data.titre.slice(0, 200) : "",
          texte,
          octets: texte.length,
          delai_respecte_s: 0,
        });
        return;
      } catch (error) {
        if (error instanceof PageReadRefused) {
          audit(caller, "page", provider.key, 200, { refus: error.message });
          res.status(200).json({ lue: false, motif: error.message, url, fournisseur: provider.key });
          return;
        }
        failures.push(provider.key);
        audit(caller, "page", provider.key, 502);
      }
    }
    res.status(502).json({ erreur: "Aucun fournisseur de lecture n’a répondu.", fournisseurs: failures });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/v1/ia", async (req, res) => {
  let caller = "inconnu";
  try {
    ({ caller } = await authenticateGatewayRequest(req));
    const input = body(req);
    const system = requiredText(input.systeme, "systeme", 8000);
    const user = requiredText(input.utilisateur, "utilisateur", 12000);
    const model = optionalText(input.modele, 200);
    if (model && !authorizedModels().includes(model)) {
      throw new GatewayAuthError(403, "Modèle non autorisé.");
    }
    await takeQuota("ia");
    const safeSystem = anonymize(system);
    const safeUser = anonymize(user);
    const providers = activeProviders("inference");
    const remoteAllowed =
      input.autorisation_tiers === true &&
      input.donnees_personnelles === false &&
      safeSystem.removed + safeUser.removed === 0;
    const failures: string[] = [];
    for (const provider of providers) {
      if (provider.key === "local-deterministe") {
        audit(caller, "ia", provider.key, 200, {
          pii_retirees: safeSystem.removed + safeUser.removed,
        });
        res.json({
          contenu: null,
          indisponible: true,
          fournisseur: provider.key,
          modele: "local-deterministe",
          pii_retirees: safeSystem.removed + safeUser.removed,
          secours: failures,
        });
        return;
      }
      if (!remoteAllowed) {
        failures.push(`${provider.key}:transmission-interdite`);
        continue;
      }
      const selectedModel = model ?? provider.models[0];
      if (!selectedModel) continue;
      try {
        const response = await providerRequest(
          provider,
          {
            model: selectedModel,
            temperature: typeof input.temperature === "number" ? input.temperature : 0.1,
            max_tokens: typeof input.max_tokens === "number" ? input.max_tokens : 900,
            messages: [
              { role: "system", content: safeSystem.text },
              { role: "user", content: safeUser.text },
            ],
          },
          120_000,
        );
        if (!response.ok) {
          failures.push(provider.key);
          audit(caller, "ia", `${provider.key}:${selectedModel}`, response.status);
          continue;
        }
        const data = (await response.json()) as Record<string, unknown>;
        const message = (
          (Array.isArray(data.choices) ? data.choices[0] : undefined) as
            | { message?: { content?: unknown } }
            | undefined
        )?.message;
        audit(caller, "ia", `${provider.key}:${selectedModel}`, 200, {
          pii_retirees: safeSystem.removed + safeUser.removed,
        });
        res.json({
          contenu: typeof message?.content === "string" ? message.content : null,
          fournisseur: provider.key,
          modele: selectedModel,
          pii_retirees: safeSystem.removed + safeUser.removed,
          secours: failures,
        });
        return;
      } catch {
        failures.push(provider.key);
        audit(caller, "ia", `${provider.key}:${selectedModel}`, 502);
      }
    }
    res.status(503).json({ erreur: "Aucun fournisseur d’inférence n’a répondu." });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/v1/collecte", async (req, res) => {
  let caller = "inconnu";
  try {
    ({ caller } = await authenticateGatewayRequest(req));
    const input = body(req);
    const source = requiredText(input.source, "source", 40).toLowerCase();
    if (!["x", "reddit"].includes(source)) {
      throw new GatewayAuthError(403, "Source non autorisée.");
    }
    if (!Array.isArray(input.mots_cles) || input.mots_cles.length < 1 || input.mots_cles.length > 12) {
      throw new GatewayAuthError(422, "mots_cles invalide.");
    }
    const motsCles = input.mots_cles.map((value) => requiredText(value, "mot_cle", 100));
    const safeKeywords = motsCles.map(anonymize);
    if (safeKeywords.some((keyword) => keyword.removed > 0)) {
      throw new GatewayAuthError(422, "La collecte contient des données personnelles ou sensibles.");
    }
    const jours = input.jours === undefined ? 3 : Number(input.jours);
    const limit = input.limite === undefined ? 300 : Number(input.limite);
    if (!Number.isInteger(jours) || jours < 1 || jours > 30 || !Number.isInteger(limit) || limit < 10 || limit > 1000) {
      throw new GatewayAuthError(422, "Paramètres de collecte invalides.");
    }
    const keywordMode =
      input.keyword_mode === undefined
        ? "any"
        : requiredText(input.keyword_mode, "keyword_mode", 10).toLowerCase();
    if (!["any", "all"].includes(keywordMode)) {
      throw new GatewayAuthError(422, "keyword_mode invalide.");
    }
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - jours * 24 * 60 * 60 * 1000);
    await takeQuota("collecte");
    const providers = activeProviders("collecte");
    if (!providers.length) throw new GatewayAuthError(503, "Aucun fournisseur de collecte configuré.");
    const failures: string[] = [];
    for (const provider of providers) {
      try {
        if (provider.key === "local-collecte") {
          audit(caller, "collecte", provider.key, 200, {
            nombre: 0,
            secours: failures.length,
            pii_retirees: safeKeywords.reduce((total, keyword) => total + keyword.removed, 0),
          });
          res.json({ publications: [], nombre: 0, fournisseur: provider.key, secours: failures });
          return;
        }
        const response = await providerRequest(
          provider,
          {
            source: source === "x" ? "X" : "Reddit",
            usernames: [],
            keywords: safeKeywords.map((keyword) => keyword.text),
            start_date: startDate.toISOString(),
            end_date: endDate.toISOString(),
            limit,
            keyword_mode: keywordMode,
          },
          180_000,
        );
        if (!response.ok) {
          failures.push(provider.key);
          audit(caller, "collecte", provider.key, response.status);
          continue;
        }
        const data = (await response.json()) as { data?: unknown[] };
        const publications = Array.isArray(data.data) ? data.data : [];
        audit(caller, "collecte", `${provider.key}:${source}`, 200, {
          nombre: publications.length,
          pii_retirees: safeKeywords.reduce((total, keyword) => total + keyword.removed, 0),
        });
        res.json({
          publications,
          nombre: publications.length,
          fournisseur: provider.key,
          secours: failures,
        });
        return;
      } catch (error) {
        failures.push(provider.key);
        audit(caller, "collecte", provider.key, 502, {
          erreur:
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error),
        });
      }
    }
    res.status(502).json({ erreur: "Aucun fournisseur de collecte n’a répondu.", fournisseurs: failures });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
