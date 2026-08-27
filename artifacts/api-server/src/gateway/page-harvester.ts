import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { URL } from "node:url";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { anonymize } from "./anonymize";

const USER_AGENT = "NovaLuthBot/1.0 (atelier-directory; respects-robots-and-tdm)";
const MIN_DELAY_MS = 1500;
const POLICY_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 1_500_000;
const MAX_POLICY_BYTES = 100_000;
const MAX_TEXT = 12_000;
const forbiddenHostFragments = [
  "instagram.com",
  "facebook.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "linkedin.com",
];

type RobotsRule = { allow: boolean; pattern: string };
type RobotsRules = { rules: RobotsRule[]; crawlDelayMs: number };
type PinnedResponse = { status: number; headers: Headers; body: Uint8Array };
const robotsCache = new Map<string, { expiresAt: number; rules: RobotsRules }>();
const tdmCache = new Map<string, { expiresAt: number; reserved: boolean }>();

export class PageReadRefused extends Error {}

function pageUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PageReadRefused("adresse invalide");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new PageReadRefused("seules les adresses http et https avec un domaine sont lues");
  }
  if (parsed.username || parsed.password) {
    throw new PageReadRefused("les adresses avec identifiants ne sont pas lues");
  }
  if (
    process.env.NODE_ENV !== "test" &&
    parsed.port &&
    parsed.port !== (parsed.protocol === "https:" ? "443" : "80")
  ) {
    throw new PageReadRefused("les ports non standard ne sont pas lus");
  }
  return parsed;
}

function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return forbiddenHostFragments.some((fragment) => host === fragment || host.endsWith(`.${fragment}`));
}

function isPublicIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const value = address.toLowerCase();
  if (value.startsWith("::ffff:")) return isPublicIpv4(value.slice(7));
  return !(
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("2001:db8")
  );
}

async function resolvePinnedAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new PageReadRefused("domaine impossible à résoudre");
  }
  const acceptable =
    process.env.NODE_ENV === "test"
      ? addresses
      : addresses.filter(({ address }) => isPublicIp(address));
  if (!acceptable.length || acceptable.length !== addresses.length) {
    throw new PageReadRefused("adresse réseau non publique refusée");
  }
  const selected = acceptable[0];
  return { address: selected.address, family: selected.family === 6 ? 6 : 4 };
}

export async function assertPublicPageUrl(url: URL): Promise<void> {
  await resolvePinnedAddress(url);
}

function headersFromNode(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) value.forEach((item) => result.append(name, item));
    else if (value !== undefined) result.set(name, value);
  }
  return result;
}

async function requestPinned(url: URL, maxBytes: number, timeoutMs: number): Promise<PinnedResponse> {
  const pinned = await resolvePinnedAddress(url);
  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: pinned.address,
        family: pinned.family,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: url.protocol === "https:" ? url.hostname : undefined,
        headers: {
          Host: url.host,
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain,application/json",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            response.destroy();
            finish(() => reject(new PageReadRefused("réponse trop volumineuse")));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          finish(() =>
            resolve({
              status: response.statusCode ?? 502,
              headers: headersFromNode(response.headers),
              body: new Uint8Array(Buffer.concat(chunks)),
            }),
          ),
        );
        response.on("error", (error) => finish(() => reject(error)));
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("délai de lecture dépassé")));
    request.on("error", (error) => finish(() => reject(error)));
    request.end();
  });
}

function parseRobots(text: string): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRule[]; delay?: number }[] = [];
  let current: { agents: string[]; rules: RobotsRule[]; delay?: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.split("#", 1)[0].trim();
    const separator = clean.indexOf(":");
    if (!clean || separator < 0) continue;
    const key = clean.slice(0, separator).trim().toLowerCase();
    const value = clean.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (current && current.rules.length === 0 && current.delay === undefined) {
        current.agents.push(value.toLowerCase());
      } else {
        current = { agents: [value.toLowerCase()], rules: [] };
        groups.push(current);
      }
    } else if (current && (key === "allow" || key === "disallow") && value) {
      current.rules.push({ allow: key === "allow", pattern: value });
    } else if (current && key === "crawl-delay" && Number.isFinite(Number(value))) {
      current.delay = Math.max(0, Number(value) * 1000);
    }
  }
  const scored = groups.map((group) => ({
    group,
    specificity: Math.max(
      0,
      ...group.agents
        .filter((agent) => agent !== "*" && "novaluthbot".startsWith(agent))
        .map((agent) => agent.length),
    ),
  }));
  const highestSpecificity = Math.max(0, ...scored.map(({ specificity }) => specificity));
  const matching =
    highestSpecificity > 0
      ? scored
          .filter(({ specificity }) => specificity === highestSpecificity)
          .map(({ group }) => group)
      : groups.filter((group) => group.agents.includes("*"));
  return {
    rules: matching.flatMap((group) => group.rules),
    crawlDelayMs: Math.max(
      MIN_DELAY_MS,
      matching.map((group) => group.delay).find((delay): delay is number => delay !== undefined) ?? MIN_DELAY_MS,
    ),
  };
}

function patternMatch(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith("$");
  const raw = anchored ? pattern.slice(0, -1) : pattern;
  const regex = raw
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${regex}${anchored ? "$" : ""}`).test(path);
}

function robotsAllows(url: URL, rules: RobotsRules): boolean {
  const path = `${url.pathname}${url.search}`;
  const matches = rules.rules
    .filter((rule) => patternMatch(path, rule.pattern))
    .sort((a, b) => b.pattern.replace(/\*/g, "").length - a.pattern.replace(/\*/g, "").length);
  if (!matches.length) return true;
  const mostSpecific = matches[0].pattern.replace(/\*/g, "").length;
  return matches.filter((rule) => rule.pattern.replace(/\*/g, "").length === mostSpecific).some((rule) => rule.allow);
}

export function robotsTextAllows(text: string, rawUrl: string): boolean {
  return robotsAllows(pageUrl(rawUrl), parseRobots(text));
}

async function robotsFor(url: URL): Promise<RobotsRules> {
  const cached = robotsCache.get(url.origin);
  if (cached && cached.expiresAt > Date.now()) return cached.rules;
  let response: PinnedResponse;
  try {
    response = await requestPinned(new URL("/robots.txt", url.origin), MAX_POLICY_BYTES, 10_000);
  } catch {
    throw new PageReadRefused("robots.txt impossible à vérifier");
  }
  if (![200, 404, 410].includes(response.status)) {
    throw new PageReadRefused(`robots.txt impossible à vérifier (${response.status})`);
  }
  const rules =
    response.status === 200
      ? parseRobots(new TextDecoder().decode(response.body))
      : { rules: [], crawlDelayMs: MIN_DELAY_MS };
  robotsCache.set(url.origin, { expiresAt: Date.now() + POLICY_CACHE_MS, rules });
  return rules;
}

async function hasTdmReservationFile(url: URL): Promise<boolean> {
  const cached = tdmCache.get(url.origin);
  if (cached && cached.expiresAt > Date.now()) return cached.reserved;
  let response: PinnedResponse;
  try {
    response = await requestPinned(new URL("/.well-known/tdmrep.json", url.origin), MAX_POLICY_BYTES, 8_000);
  } catch {
    throw new PageReadRefused("réservation TDM impossible à vérifier");
  }
  if (![200, 404, 410].includes(response.status)) {
    throw new PageReadRefused(`réservation TDM impossible à vérifier (${response.status})`);
  }
  const reserved =
    response.status === 200 &&
    /"tdm-reservation"\s*:\s*(?:1|true)/i.test(new TextDecoder().decode(response.body));
  tdmCache.set(url.origin, { expiresAt: Date.now() + POLICY_CACHE_MS, reserved });
  return reserved;
}

function hasTdmReservation(headers: Headers, html: string): boolean {
  if (/(?:noai|noimageai|tdm|noindex)/i.test(headers.get("x-robots-tag") ?? "")) return true;
  return (html.match(/<meta\b[^>]*>/gi) ?? []).some(
    (tag) =>
      /name\s*=\s*["']?(?:robots|tdm-reservation)/i.test(tag) &&
      /content\s*=\s*["'][^"']*(?:noai|noimageai|tdm-reservation|noindexai)/i.test(tag),
  );
}

async function reserveDomainVisit(domain: string, crawlDelayMs: number): Promise<void> {
  const result = await db.execute<{ next_allowed_at: Date }>(sql`
    insert into novaluth_gateway_domain_visits (domain, next_allowed_at, updated_at)
    values (${domain}, now() + (${crawlDelayMs} * interval '1 millisecond'), now())
    on conflict (domain) do update
      set next_allowed_at = now() + (${crawlDelayMs} * interval '1 millisecond'), updated_at = now()
      where novaluth_gateway_domain_visits.next_allowed_at <= now()
    returning next_allowed_at
  `);
  if (result.rows.length) return;
  const next = await db.execute<{ next_allowed_at: Date }>(sql`
    select next_allowed_at from novaluth_gateway_domain_visits where domain = ${domain}
  `);
  const nextAt = next.rows[0]?.next_allowed_at;
  const nextTime = nextAt instanceof Date ? nextAt.getTime() : new Date(nextAt ?? Date.now()).getTime();
  throw new PageReadRefused(
    `ce domaine a déjà été lu ; nouvelle lecture dans ${Math.max(1, Math.ceil((nextTime - Date.now()) / 1000))} s`,
  );
}

function readableText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim()
    .slice(0, MAX_TEXT);
}

function titleOf(html: string): string {
  return (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/gi, "&")
    .trim()
    .slice(0, 200);
}

async function fetchPublicPage(startUrl: URL) {
  let current = startUrl;
  let delayMs = MIN_DELAY_MS;
  const reservedOrigins = new Set<string>();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (isForbiddenHost(current.hostname)) throw new PageReadRefused("les réseaux sociaux ne sont pas lus directement");
    const rules = await robotsFor(current);
    if (!robotsAllows(current, rules)) throw new PageReadRefused("robots.txt interdit cette lecture");
    if (await hasTdmReservationFile(current)) {
      throw new PageReadRefused("réservation de fouille déclarée dans /.well-known/tdmrep.json");
    }
    delayMs = rules.crawlDelayMs;
    if (!reservedOrigins.has(current.origin)) {
      await reserveDomainVisit(current.hostname.toLowerCase(), delayMs);
      reservedOrigins.add(current.origin);
    }
    const response = await requestPinned(current, MAX_BYTES, 25_000);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return { response, url: current, delayMs };
    }
    current = pageUrl(new URL(location, current).toString());
  }
  throw new PageReadRefused("trop de redirections");
}

export function urlForExternalPageFallback(rawUrl: string): string {
  const sanitized = pageUrl(rawUrl);
  const path = anonymize(decodeURIComponent(sanitized.pathname));
  if (path.removed > 0) {
    throw new PageReadRefused("l’adresse contient des données sensibles et ne peut pas être transmise");
  }
  sanitized.pathname = path.text;
  sanitized.search = "";
  sanitized.hash = "";
  return sanitized.toString();
}

export async function readPublicPage(rawUrl: string) {
  const initial = pageUrl(rawUrl);
  const { response, url, delayMs } = await fetchPublicPage(initial);
  if (response.status >= 400) throw new PageReadRefused(`la page a répondu ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/(?:html|text)/i.test(contentType)) {
    throw new PageReadRefused(`contenu non textuel (${contentType || "inconnu"})`);
  }
  const html = new TextDecoder().decode(response.body);
  if (hasTdmReservation(response.headers, html)) throw new PageReadRefused("le site réserve la fouille de données");
  return {
    url: initial.toString(),
    url_finale: url.toString(),
    titre: titleOf(html),
    texte: readableText(html),
    octets: response.body.byteLength,
    delai_respecte_s: delayMs / 1000,
  };
}