import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { eq, like } from "drizzle-orm";
import {
  db,
  novaluthEmailOutboxTable,
  novaluthSn13AlertStateTable,
  novaluthSn13CallEventsTable,
  novaluthSn13DiagnosticsTable,
} from "@workspace/db";
import app from "../app";
import { anonymize } from "./anonymize";
import { logger } from "../lib/logger";
import {
  requestDataUniverse,
  activeProviders,
  setSn13ClientFactoryForTests,
  type DataUniverseRequest,
} from "./provider-registry";
import { assertPublicPageUrl, readPublicPage, robotsTextAllows } from "./page-harvester";

let apiServer: Server;
let apiOrigin = "";
let robotsServer: Server;
let robotsOrigin = "";
let reservationServer: Server;
let reservationOrigin = "";
let previousNodeEnv: string | undefined;
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const sn13ProcessRunner = path.join(
  workspaceRoot,
  "artifacts/api-server/src/routes/sn13-diagnostic-process.integration.ts",
);
const tsxBinary = path.join(workspaceRoot, "scripts/node_modules/.bin/tsx");

function originFor(server: Server) {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function clearSn13AlertTracking() {
  await db.delete(novaluthSn13CallEventsTable);
  await db.delete(novaluthSn13AlertStateTable);
}

type Sn13ProcessOptions = {
  status?: "erreur" | "incomplet" | "vide" | "succes";
  calledAt?: number;
  calls?: number;
  betweenCallsDelayMs?: number;
};

type Sn13DiagnosticSnapshot = {
  statut: string;
  requete_id: string | null;
  appele_le: string | null;
  corps_erreur: string | null;
  recents: {
    fenetre_heures: number;
    total: number;
    succes: number;
    vide: number;
    incomplet: number;
    erreur: number;
    alerte: boolean;
  };
};

function runSn13Process(
  mode: "write" | "read",
  requestId: string,
  secret: string,
  options: Sn13ProcessOptions = {},
): Promise<Sn13DiagnosticSnapshot | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBinary, [sn13ProcessRunner, mode], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        NODE_ENV: "test",
        SN13_DIAGNOSTIC_TEST_REQUEST_ID: requestId,
        SN13_DIAGNOSTIC_TEST_SECRET: secret,
        SN13_DIAGNOSTIC_TEST_STATUS: options.status ?? "erreur",
        SN13_DIAGNOSTIC_TEST_CALLED_AT: options.calledAt?.toString() ?? "",
        SN13_DIAGNOSTIC_TEST_CALLS: options.calls?.toString() ?? "",
        SN13_DIAGNOSTIC_TEST_BETWEEN_CALLS_DELAY_MS:
          options.betweenCallsDelayMs?.toString() ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Le processus SN13 a échoué (${code}). ${errorOutput.slice(0, 500)}`));
        return;
      }
      if (mode === "write") {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(output) as Sn13DiagnosticSnapshot);
      } catch {
        reject(new Error(`Réponse JSON invalide du processus SN13 ${mode}.`));
      }
    });
  });
}

before(async () => {
  previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  apiServer = createServer(app);
  robotsServer = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.setHeader("Content-Type", "text/plain");
      res.end("User-agent: *\nDisallow: /atelier-refuse\n");
      return;
    }
    if (req.url === "/redirect-reserve") {
      res.statusCode = 302;
      res.setHeader("Location", `${reservationOrigin}/atelier-reserve`);
      res.end();
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end("<html><title>Atelier test</title><body>Ne devrait pas être lu.</body></html>");
  });
  reservationServer = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.url === "/.well-known/tdmrep.json") {
      res.setHeader("Content-Type", "application/json");
      res.end('{"tdm-reservation": 1}');
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end("<html><title>Réservé</title><body>Ne devrait pas être lu.</body></html>");
  });
  await Promise.all([
    new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => robotsServer.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => reservationServer.listen(0, "127.0.0.1", resolve)),
  ]);
  apiOrigin = originFor(apiServer);
  robotsOrigin = originFor(robotsServer);
  reservationOrigin = originFor(reservationServer);
});

after(async () => {
  await Promise.all([close(apiServer), close(robotsServer), close(reservationServer)]);
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

test("anonymizes personal data before a provider call", () => {
  const result = anonymize(
    "Écrire à musicien@example.test ou appeler +33 6 12 34 56 78, 12 rue des Érables.",
  );
  assert.equal(result.removed, 3);
  assert.doesNotMatch(result.text, /musicien@example\.test|\+33 6 12 34 56 78|rue des Érables/);
});

test("strips tokens and identifiers from provider-bound text", () => {
  const result = anonymize(
    "token=abc123 secret-value 203.0.113.4 58f5b92a-78b0-4f1b-910b-33ad40c4ff10",
  );
  assert.equal(result.removed, 3);
  assert.doesNotMatch(result.text, /abc123|203\.0\.113\.4|58f5b92a/);
});

test("refuses private network targets outside the test harness", async () => {
  const currentNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      assertPublicPageUrl(new URL("http://127.0.0.1/secret")),
      /adresse réseau non publique/,
    );
  } finally {
    if (currentNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = currentNodeEnv;
  }
});

test("uses the most specific robots agent group", () => {
  const rules = [
    "User-agent: NovaLuth",
    "Allow: /private",
    "",
    "User-agent: OtherBot",
    "User-agent: NovaLuthBot",
    "Disallow: /private",
  ].join("\n");
  assert.equal(robotsTextAllows(rules, "https://example.com/private/atelier"), false);
});

test("switches a named provider chain without exposing its API key", async () => {
  const previousKey = process.env.DESEARCH_API_KEY;
  const previousInferenceKey = process.env.CHUTES_API_KEY;
  process.env.DESEARCH_API_KEY = "test-key-never-returned";
  process.env.CHUTES_API_KEY = "second-test-key-never-returned";
  try {
    assert.equal(activeProviders("recherche")[0]?.key, "desearch");
    assert.equal(activeProviders("inference")[0]?.key, "chutes");
    const response = await fetch(`${apiOrigin}/api/transparence`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"cle":"desearch"/);
    assert.doesNotMatch(text, /test-key-never-returned/);
  } finally {
    if (previousKey === undefined) delete process.env.DESEARCH_API_KEY;
    else process.env.DESEARCH_API_KEY = previousKey;
    if (previousInferenceKey === undefined) delete process.env.CHUTES_API_KEY;
    else process.env.CHUTES_API_KEY = previousInferenceKey;
  }
});

test("refuses robots and TDM-reserved pages through the signed gateway route", async () => {
  const previousSecret = process.env.NOVALUTH_GATEWAY_SECRET;
  const secret = "a".repeat(40);
  process.env.NOVALUTH_GATEWAY_SECRET = secret;
  try {
    const requestBody = JSON.stringify({ url: `${robotsOrigin}/atelier-refuse` });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const signature = createHmac("sha256", secret)
      .update(`POST./api/v1/page.${timestamp}.${nonce}.${requestBody}`)
      .digest("hex");
    const response = await fetch(`${apiOrigin}/api/v1/page`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-NovaLuth-Timestamp": timestamp,
        "X-NovaLuth-Nonce": nonce,
        "X-NovaLuth-Signature": signature,
      },
      body: requestBody,
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { lue: boolean; motif: string };
    assert.equal(payload.lue, false);
    assert.match(payload.motif, /robots\.txt/);

    const replay = await fetch(`${apiOrigin}/api/v1/page`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-NovaLuth-Timestamp": timestamp,
        "X-NovaLuth-Nonce": nonce,
        "X-NovaLuth-Signature": signature,
      },
      body: requestBody,
    });
    assert.equal(replay.status, 401);

    await assert.rejects(
      readPublicPage(`${reservationOrigin}/atelier-reserve`),
      /réservation de fouille/,
    );
    await assert.rejects(
      readPublicPage(`${robotsOrigin}/redirect-reserve`),
      /réservation de fouille/,
    );
  } finally {
    if (previousSecret === undefined) delete process.env.NOVALUTH_GATEWAY_SECRET;
    else process.env.NOVALUTH_GATEWAY_SECRET = previousSecret;
  }
});

test("notifies the team once when SN13 crosses the incomplete-response threshold", async () => {
  const previousAlertEmail = process.env.NOVALUTH_ALERT_EMAIL;
  const previousSn13AlertEmail = process.env.NOVALUTH_SN13_ALERT_EMAIL;
  const dedupePattern = "sn13:degradation:%";
  await db.delete(novaluthEmailOutboxTable).where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
  await clearSn13AlertTracking();
  delete process.env.NOVALUTH_SN13_ALERT_EMAIL;
  process.env.NOVALUTH_ALERT_EMAIL = "equipe@example.test";
  setSn13ClientFactoryForTests(() => ({
    onDemandData: async () => ({
      status: "success",
      data: "not-a-publication-array" as unknown as [],
      meta: { request_id: "sn13-alert-test-request" },
    }),
  }));

  try {
    const request = {
      source: "X" as const,
      usernames: [],
      keywords: ["lutherie"],
      startDate: "2026-03-01",
      endDate: "2026-08-31",
      limit: 100,
      keywordMode: "any" as const,
    };

    await requestDataUniverse(request);
    let alerts = await db
      .select()
      .from(novaluthEmailOutboxTable)
      .where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
    assert.equal(alerts.length, 0);

    await requestDataUniverse(request);
    alerts = await db
      .select()
      .from(novaluthEmailOutboxTable)
      .where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.recipient, "equipe@example.test");
    assert.equal(alerts[0]?.event, "sn13_degradation");
    assert.doesNotMatch(JSON.stringify(alerts[0]?.payload), /request|publication-array|secret|api[_-]?key/i);

    await requestDataUniverse(request);
    alerts = await db
      .select()
      .from(novaluthEmailOutboxTable)
      .where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
    assert.equal(alerts.length, 1);
  } finally {
    await db.delete(novaluthEmailOutboxTable).where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
    await clearSn13AlertTracking();
    setSn13ClientFactoryForTests(null);
    if (previousAlertEmail === undefined) delete process.env.NOVALUTH_ALERT_EMAIL;
    else process.env.NOVALUTH_ALERT_EMAIL = previousAlertEmail;
    if (previousSn13AlertEmail === undefined) delete process.env.NOVALUTH_SN13_ALERT_EMAIL;
    else process.env.NOVALUTH_SN13_ALERT_EMAIL = previousSn13AlertEmail;
  }
});

test("crée une seule alerte SN13 quand deux processus franchissent le seuil simultanément", async () => {
  const previousAlertEmail = process.env.NOVALUTH_ALERT_EMAIL;
  const previousSn13AlertEmail = process.env.NOVALUTH_SN13_ALERT_EMAIL;
  const dedupePattern = "sn13:degradation:%";
  const episodeStartedAt = Date.now();
  const firstRequestId = `sn13-concurrent-alert-first-${randomUUID()}`;
  const secondRequestId = `sn13-concurrent-alert-second-${randomUUID()}`;
  const firstSecret = `sn13-concurrent-alert-first-secret-${randomUUID()}`;
  const secondSecret = `sn13-concurrent-alert-second-secret-${randomUUID()}`;

  await db.delete(novaluthEmailOutboxTable).where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
  await db
    .delete(novaluthSn13DiagnosticsTable)
    .where(eq(novaluthSn13DiagnosticsTable.key, "latest"));
  await db.delete(novaluthSn13CallEventsTable);
  await db.delete(novaluthSn13AlertStateTable);
  delete process.env.NOVALUTH_SN13_ALERT_EMAIL;
  process.env.NOVALUTH_ALERT_EMAIL = "equipe@example.test";

  try {
    await Promise.all([
      runSn13Process("write", firstRequestId, firstSecret, {
        status: "incomplet",
        calledAt: episodeStartedAt,
        calls: 2,
        betweenCallsDelayMs: 100,
      }),
      runSn13Process("write", secondRequestId, secondSecret, {
        status: "incomplet",
        calledAt: episodeStartedAt + 7,
        calls: 2,
        betweenCallsDelayMs: 100,
      }),
    ]);

    const alerts = await db
      .select()
      .from(novaluthEmailOutboxTable)
      .where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]?.dedupeKey ?? "", /^sn13:degradation:\d+$/);
    assert.equal(alerts[0]?.recipient, "equipe@example.test");
    assert.equal(alerts[0]?.event, "sn13_degradation");

    const firstEpisodeKey = alerts[0]?.dedupeKey;
    const nextEpisodeStartedAt = episodeStartedAt + 24 * 60 * 60 * 1_000 + 1_000;
    await runSn13Process(
      "write",
      `sn13-concurrent-alert-next-${randomUUID()}`,
      `sn13-concurrent-alert-next-secret-${randomUUID()}`,
      {
        status: "incomplet",
        calledAt: nextEpisodeStartedAt,
        calls: 2,
      },
    );
    const nextAlerts = await db
      .select()
      .from(novaluthEmailOutboxTable)
      .where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
    assert.equal(nextAlerts.length, 2);
    assert.notEqual(nextAlerts[0]?.dedupeKey, nextAlerts[1]?.dedupeKey);
    assert.ok(nextAlerts.some((alert) => alert.dedupeKey === firstEpisodeKey));
  } finally {
    await db.delete(novaluthEmailOutboxTable).where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
    await db.delete(novaluthSn13CallEventsTable);
    await db.delete(novaluthSn13AlertStateTable);
    await db
      .delete(novaluthSn13DiagnosticsTable)
      .where(eq(novaluthSn13DiagnosticsTable.key, "latest"));
    if (previousAlertEmail === undefined) delete process.env.NOVALUTH_ALERT_EMAIL;
    else process.env.NOVALUTH_ALERT_EMAIL = previousAlertEmail;
    if (previousSn13AlertEmail === undefined) delete process.env.NOVALUTH_SN13_ALERT_EMAIL;
    else process.env.NOVALUTH_SN13_ALERT_EMAIL = previousSn13AlertEmail;
  }
});

test("récupère les compteurs SN13 persistés après un redémarrage", async () => {
  const previousAlertEmail = process.env.NOVALUTH_ALERT_EMAIL;
  const previousSn13AlertEmail = process.env.NOVALUTH_SN13_ALERT_EMAIL;
  const dedupePattern = "sn13:degradation:%";
  const calledAt = Date.now();
  const requestId = `sn13-restart-diagnostics-${randomUUID()}`;
  const secret = `sn13-restart-diagnostics-secret-${randomUUID()}`;

  await db.delete(novaluthEmailOutboxTable).where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
  await db
    .delete(novaluthSn13DiagnosticsTable)
    .where(eq(novaluthSn13DiagnosticsTable.key, "latest"));
  await db.delete(novaluthSn13CallEventsTable);
  await db.delete(novaluthSn13AlertStateTable);
  delete process.env.NOVALUTH_ALERT_EMAIL;
  delete process.env.NOVALUTH_SN13_ALERT_EMAIL;

  try {
    await runSn13Process("write", requestId, secret, {
      status: "incomplet",
      calledAt,
      calls: 2,
    });

    // The first process has exited; this second process simulates the server restart.
    const restarted = await runSn13Process("read", requestId, secret);
    assert.ok(restarted);
    assert.equal(restarted.statut, "incomplet");
    assert.equal(restarted.requete_id, `${requestId}-1`);
    assert.equal(restarted.recents.fenetre_heures, 24);
    assert.equal(restarted.recents.total, 2);
    assert.equal(restarted.recents.succes, 0);
    assert.equal(restarted.recents.vide, 0);
    assert.equal(restarted.recents.incomplet, 2);
    assert.equal(restarted.recents.erreur, 0);
    assert.equal(restarted.recents.alerte, true);
  } finally {
    await db.delete(novaluthEmailOutboxTable).where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
    await db.delete(novaluthSn13CallEventsTable);
    await db.delete(novaluthSn13AlertStateTable);
    await db
      .delete(novaluthSn13DiagnosticsTable)
      .where(eq(novaluthSn13DiagnosticsTable.key, "latest"));
    if (previousAlertEmail === undefined) delete process.env.NOVALUTH_ALERT_EMAIL;
    else process.env.NOVALUTH_ALERT_EMAIL = previousAlertEmail;
    if (previousSn13AlertEmail === undefined) delete process.env.NOVALUTH_SN13_ALERT_EMAIL;
    else process.env.NOVALUTH_SN13_ALERT_EMAIL = previousSn13AlertEmail;
  }
});

test("conserve une alerte SN13 après un redémarrage entre deux franchissements", async () => {
  const previousAlertEmail = process.env.NOVALUTH_ALERT_EMAIL;
  const previousSn13AlertEmail = process.env.NOVALUTH_SN13_ALERT_EMAIL;
  const dedupePattern = "sn13:degradation:%";
  const episodeStartedAt = Date.now();
  const firstRequestId = `sn13-restart-alert-first-${randomUUID()}`;
  const secondRequestId = `sn13-restart-alert-second-${randomUUID()}`;
  const firstSecret = `sn13-restart-alert-first-secret-${randomUUID()}`;
  const secondSecret = `sn13-restart-alert-second-secret-${randomUUID()}`;

  await db
    .delete(novaluthEmailOutboxTable)
    .where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
  await db
    .delete(novaluthSn13DiagnosticsTable)
    .where(eq(novaluthSn13DiagnosticsTable.key, "latest"));
  await db.delete(novaluthSn13CallEventsTable);
  await db.delete(novaluthSn13AlertStateTable);
  delete process.env.NOVALUTH_SN13_ALERT_EMAIL;
  process.env.NOVALUTH_ALERT_EMAIL = "equipe@example.test";

  try {
    await runSn13Process("write", firstRequestId, firstSecret, {
      status: "incomplet",
      calledAt: episodeStartedAt,
      calls: 1,
    });

    let alerts = await db
      .select()
      .from(novaluthEmailOutboxTable)
      .where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
    assert.equal(alerts.length, 0);

    // The first process has exited; this second process simulates the server restart.
    await runSn13Process("write", secondRequestId, secondSecret, {
      status: "incomplet",
      calledAt: episodeStartedAt + 1,
      calls: 1,
    });

    alerts = await db
      .select()
      .from(novaluthEmailOutboxTable)
      .where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
    assert.equal(alerts.length, 1);
    assert.equal(
      alerts[0]?.dedupeKey,
      `sn13:degradation:${episodeStartedAt + 1}`,
    );
    assert.equal(alerts[0]?.recipient, "equipe@example.test");
    assert.equal(alerts[0]?.event, "sn13_degradation");
  } finally {
    await db
      .delete(novaluthEmailOutboxTable)
      .where(like(novaluthEmailOutboxTable.dedupeKey, dedupePattern));
    await db.delete(novaluthSn13CallEventsTable);
    await db.delete(novaluthSn13AlertStateTable);
    await db
      .delete(novaluthSn13DiagnosticsTable)
      .where(eq(novaluthSn13DiagnosticsTable.key, "latest"));
    if (previousAlertEmail === undefined)
      delete process.env.NOVALUTH_ALERT_EMAIL;
    else process.env.NOVALUTH_ALERT_EMAIL = previousAlertEmail;
    if (previousSn13AlertEmail === undefined)
      delete process.env.NOVALUTH_SN13_ALERT_EMAIL;
    else process.env.NOVALUTH_SN13_ALERT_EMAIL = previousSn13AlertEmail;
  }
});

test("keeps SN13 failures visible and redacted without duplicating their audit", async () => {
  const previousGatewaySecret = process.env.NOVALUTH_GATEWAY_SECRET;
  const previousSn13Key = process.env.SN13_API_KEY;
  const gatewaySecret = "gateway-test-secret".repeat(3);
  const sn13Key = "sn13-provider-secret-never-visible";
  const requestId = "sn13-request-test-123";
  const originalLoggerInfo = logger.info;
  const sn13Audits: Record<string, unknown>[] = [];
  const capturedRequests: DataUniverseRequest[] = [];

  process.env.NOVALUTH_GATEWAY_SECRET = gatewaySecret;
  process.env.SN13_API_KEY = sn13Key;
  setSn13ClientFactoryForTests(() => ({
    onDemandData: async (request) => {
      capturedRequests.push(request as DataUniverseRequest);
      return {
        status: "error",
        data: [],
        meta: {
          request_id: requestId,
          detail: `upstream failed with api_key=${sn13Key}`,
          authorization: `Bearer ${sn13Key}`,
        },
      };
    },
  }));
  logger.info = ((details: unknown, message?: string) => {
    if (
      message === "NovaLuth gateway audit" &&
      details &&
      typeof details === "object" &&
      (details as Record<string, unknown>).cible === "data-universe"
    ) {
      sn13Audits.push(details as Record<string, unknown>);
    }
  }) as typeof logger.info;

  const adminSummary = async () => {
    const response = await fetch(`${apiOrigin}/api/admin/summary`, {
      headers: { "X-Admin-Token": "demo-admin" },
    });
    assert.equal(response.status, 200);
    return (await response.json()) as {
      compteurs: Record<string, number>;
      collecte_sn13: {
        statut: string;
        requete_id: string | null;
        corps_erreur: string | null;
        recents: {
          total: number;
          succes: number;
          vide: number;
          incomplet: number;
          erreur: number;
          alerte: boolean;
        };
      };
    };
  };

  const collect = async () => {
    const requestBody = JSON.stringify({
      source: "x",
      usernames: ["atelier_un", "atelier_deux", "atelier_trois", "atelier_quatre", "atelier_cinq"],
      mots_cles: ["lutherie", "luthier", "guitare artisanale", "handmade guitar", "custom guitar"],
      start_date: "2026-03-01",
      end_date: "2026-08-31",
      limite: 100,
      keyword_mode: "any",
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const signature = createHmac("sha256", gatewaySecret)
      .update(`POST./v1/collecte.${timestamp}.${nonce}.${requestBody}`)
      .digest("hex");
    const response = await fetch(`${apiOrigin}/v1/collecte`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-NovaLuth-Timestamp": timestamp,
        "X-NovaLuth-Nonce": nonce,
        "X-NovaLuth-Signature": signature,
      },
      body: requestBody,
    });
    assert.equal(response.status, 200);
    return (await response.json()) as {
      publications: unknown[];
      nombre: number;
      etat_collecte: string;
      fournisseur: string;
      secours: string[];
    };
  };

  try {
    const beforeSummary = await adminSummary();
    const first = await collect();
    const second = await collect();
    const afterSummary = await adminSummary();

    for (const result of [first, second]) {
      assert.equal(result.publications.length, 1);
      assert.equal(result.nombre, 1);
      assert.equal(result.etat_collecte, "donnees");
      assert.equal(result.fournisseur, "local-collecte");
      assert.deepEqual(result.secours, ["data-universe"]);
    }
    assert.ok(
      afterSummary.compteurs.candidate >= beforeSummary.compteurs.candidate,
      "La collecte locale doit conserver ou créer la candidate saisie.",
    );
    assert.equal(afterSummary.collecte_sn13.statut, "erreur");
    assert.equal(afterSummary.collecte_sn13.requete_id, requestId);
    assert.match(afterSummary.collecte_sn13.corps_erreur ?? "", /\[REDACTED\]/);
    assert.doesNotMatch(afterSummary.collecte_sn13.corps_erreur ?? "", new RegExp(sn13Key));
    assert.equal(capturedRequests.length, 2);
    for (const request of capturedRequests) {
      assert.deepEqual(Object.keys(request).sort(), [
        "endDate",
        "keywordMode",
        "keywords",
        "limit",
        "source",
        "startDate",
        "usernames",
      ]);
      assert.equal(request.source, "X");
      assert.deepEqual(request.keywords, [
        "lutherie",
        "luthier",
        "guitare artisanale",
        "handmade guitar",
        "custom guitar",
      ]);
      assert.deepEqual(request.usernames, [
        "atelier_un",
        "atelier_deux",
        "atelier_trois",
        "atelier_quatre",
        "atelier_cinq",
      ]);
      assert.equal(request.startDate, "2026-03-01");
      assert.equal(request.endDate, "2026-08-31");
      assert.equal(request.limit, 100);
      assert.equal(request.keywordMode, "any");
      assert.equal("start_date" in request, false);
      assert.equal("end_date" in request, false);
      assert.equal("keyword_mode" in request, false);
    }
    assert.equal(sn13Audits.length, 1);
    assert.equal(sn13Audits[0]?.requete_id, requestId);
    assert.match(String(sn13Audits[0]?.erreur), /\[REDACTED\]/);
    assert.doesNotMatch(String(sn13Audits[0]?.erreur), new RegExp(sn13Key));
  } finally {
    logger.info = originalLoggerInfo;
    setSn13ClientFactoryForTests(null);
    await clearSn13AlertTracking();
    if (previousGatewaySecret === undefined) delete process.env.NOVALUTH_GATEWAY_SECRET;
    else process.env.NOVALUTH_GATEWAY_SECRET = previousGatewaySecret;
    if (previousSn13Key === undefined) delete process.env.SN13_API_KEY;
    else process.env.SN13_API_KEY = previousSn13Key;
  }
});

test("returns successful SN13 publications unchanged without using the fallback", async () => {
  const previousGatewaySecret = process.env.NOVALUTH_GATEWAY_SECRET;
  const previousSn13Key = process.env.SN13_API_KEY;
  const gatewaySecret = "gateway-success-test-secret".repeat(2);
  const publication = {
    id: "sn13-post-001",
    text: "Guitare artisanale en érable ondé",
    username: "atelier_lumiere",
    created_at: "2026-08-30T12:00:00Z",
    metadata: {
      source: "X",
      tags: ["lutherie", "guitare"],
    },
  };

  process.env.NOVALUTH_GATEWAY_SECRET = gatewaySecret;
  process.env.SN13_API_KEY = "sn13-success-test-secret";
  setSn13ClientFactoryForTests(() => ({
    onDemandData: async () => ({
      status: "success",
      data: [publication],
      meta: { request_id: "sn13-success-request-001" },
    }),
  }));

  try {
    const requestBody = JSON.stringify({
      source: "x",
      usernames: [],
      mots_cles: ["lutherie"],
      start_date: "2026-03-01",
      end_date: "2026-08-31",
      limite: 100,
      keyword_mode: "any",
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const signature = createHmac("sha256", gatewaySecret)
      .update(`POST./v1/collecte.${timestamp}.${nonce}.${requestBody}`)
      .digest("hex");
    const response = await fetch(`${apiOrigin}/v1/collecte`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-NovaLuth-Timestamp": timestamp,
        "X-NovaLuth-Nonce": nonce,
        "X-NovaLuth-Signature": signature,
      },
      body: requestBody,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      publications: [publication],
      nombre: 1,
      etat_collecte: "donnees",
      fournisseur: "data-universe",
      secours: [],
    });
  } finally {
    setSn13ClientFactoryForTests(null);
    if (previousGatewaySecret === undefined) delete process.env.NOVALUTH_GATEWAY_SECRET;
    else process.env.NOVALUTH_GATEWAY_SECRET = previousGatewaySecret;
    if (previousSn13Key === undefined) delete process.env.SN13_API_KEY;
    else process.env.SN13_API_KEY = previousSn13Key;
  }
});

test("marks malformed successful SN13 responses as incomplete", async () => {
  const previousGatewaySecret = process.env.NOVALUTH_GATEWAY_SECRET;
  const previousSn13Key = process.env.SN13_API_KEY;
  const gatewaySecret = "gateway-incomplete-test-secret".repeat(2);
  const requestId = "sn13-incomplete-request-001";
  const originalLoggerInfo = logger.info;
  const sn13Audits: Record<string, unknown>[] = [];

  process.env.NOVALUTH_GATEWAY_SECRET = gatewaySecret;
  process.env.SN13_API_KEY = "sn13-incomplete-test-secret";
  setSn13ClientFactoryForTests(() => ({
    onDemandData: async () => ({
      status: "success",
      data: "not-a-publication-array" as unknown as [],
      meta: { request_id: requestId },
    }),
  }));
  logger.info = ((details: unknown, message?: string) => {
    if (
      message === "NovaLuth gateway audit" &&
      details &&
      typeof details === "object" &&
      (details as Record<string, unknown>).cible === "data-universe"
    ) {
      sn13Audits.push(details as Record<string, unknown>);
    }
  }) as typeof logger.info;

  const adminSummary = async () => {
    const response = await fetch(`${apiOrigin}/api/admin/summary`, {
      headers: { "X-Admin-Token": "demo-admin" },
    });
    assert.equal(response.status, 200);
    return (await response.json()) as {
      compteurs: Record<string, number>;
      collecte_sn13: {
        statut: string;
        requete_id: string | null;
        corps_erreur: string | null;
        recents: {
          total: number;
          succes: number;
          vide: number;
          incomplet: number;
          erreur: number;
          alerte: boolean;
        };
      };
    };
  };

  try {
    const beforeSummary = await adminSummary();
    const collect = async () => {
      const requestBody = JSON.stringify({
        source: "x",
        usernames: [],
        mots_cles: ["lutherie"],
        start_date: "2026-03-01",
        end_date: "2026-08-31",
        limite: 100,
        keyword_mode: "any",
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomUUID();
      const signature = createHmac("sha256", gatewaySecret)
        .update(`POST./v1/collecte.${timestamp}.${nonce}.${requestBody}`)
        .digest("hex");
      const response = await fetch(`${apiOrigin}/v1/collecte`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-NovaLuth-Timestamp": timestamp,
          "X-NovaLuth-Nonce": nonce,
          "X-NovaLuth-Signature": signature,
        },
        body: requestBody,
      });
      assert.equal(response.status, 200);
      return (await response.json()) as {
        publications: unknown[];
        nombre: number;
        etat_collecte: string;
        fournisseur: string;
        secours: string[];
      };
    };

    for (const result of [await collect(), await collect()]) {
      assert.equal(result.publications.length, 1);
      assert.equal(result.nombre, 1);
      assert.equal(result.etat_collecte, "donnees");
      assert.equal(result.fournisseur, "local-collecte");
      assert.deepEqual(result.secours, ["data-universe"]);
    }

    const afterSummary = await adminSummary();
    assert.ok(afterSummary.compteurs.candidate >= beforeSummary.compteurs.candidate);
    assert.equal(afterSummary.collecte_sn13.statut, "incomplet");
    assert.equal(afterSummary.collecte_sn13.requete_id, requestId);
    assert.match(afterSummary.collecte_sn13.corps_erreur ?? "", /not-a-publication-array/);
    assert.equal(
      afterSummary.collecte_sn13.recents.total,
      beforeSummary.collecte_sn13.recents.total + 2,
    );
    assert.equal(
      afterSummary.collecte_sn13.recents.incomplet,
      beforeSummary.collecte_sn13.recents.incomplet + 2,
    );
    assert.equal(afterSummary.collecte_sn13.recents.succes, beforeSummary.collecte_sn13.recents.succes);
    assert.equal(afterSummary.collecte_sn13.recents.vide, beforeSummary.collecte_sn13.recents.vide);
    assert.equal(afterSummary.collecte_sn13.recents.erreur, beforeSummary.collecte_sn13.recents.erreur);
    assert.equal(afterSummary.collecte_sn13.recents.alerte, true);
    assert.doesNotMatch(JSON.stringify(afterSummary.collecte_sn13.recents), /not-a-publication-array/);
    assert.equal(sn13Audits.length, 1);
    assert.equal(sn13Audits[0]?.statut, 502);
    assert.equal(sn13Audits[0]?.etat, "incomplet");
    assert.equal(sn13Audits[0]?.requete_id, requestId);
  } finally {
    logger.info = originalLoggerInfo;
    setSn13ClientFactoryForTests(null);
    await clearSn13AlertTracking();
    if (previousGatewaySecret === undefined) delete process.env.NOVALUTH_GATEWAY_SECRET;
    else process.env.NOVALUTH_GATEWAY_SECRET = previousGatewaySecret;
    if (previousSn13Key === undefined) delete process.env.SN13_API_KEY;
    else process.env.SN13_API_KEY = previousSn13Key;
  }
});

test("loads manual luthiers into candidate profiles when SN13 is unavailable", async () => {
  const previousGatewaySecret = process.env.NOVALUTH_GATEWAY_SECRET;
  const previousSn13Key = process.env.SN13_API_KEY;
  const gatewaySecret = "gateway-local-collecte-test-secret".repeat(2);

  process.env.NOVALUTH_GATEWAY_SECRET = gatewaySecret;
  process.env.SN13_API_KEY = "sn13-local-collecte-test-secret";
  setSn13ClientFactoryForTests(() => ({
    onDemandData: async () => ({
      status: "error",
      data: [],
      meta: { request_id: "sn13-local-collecte-request-001" },
    }),
  }));

  try {
    const requestBody = JSON.stringify({
      source: "x",
      usernames: [],
      mots_cles: ["lutherie"],
      start_date: "2026-08-01",
      end_date: "2026-08-31",
      limite: 10,
      keyword_mode: "any",
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const signature = createHmac("sha256", gatewaySecret)
      .update(`POST./v1/collecte.${timestamp}.${nonce}.${requestBody}`)
      .digest("hex");
    const response = await fetch(`${apiOrigin}/v1/collecte`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-NovaLuth-Timestamp": timestamp,
        "X-NovaLuth-Nonce": nonce,
        "X-NovaLuth-Signature": signature,
      },
      body: requestBody,
    });

    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      publications: Array<Record<string, unknown>>;
      nombre: number;
      etat_collecte: string;
      fournisseur: string;
      secours: string[];
    };
    assert.equal(payload.nombre, 1);
    assert.equal(payload.etat_collecte, "donnees");
    assert.equal(payload.fournisseur, "local-collecte");
    assert.deepEqual(payload.secours, ["data-universe"]);
    assert.equal(payload.publications[0]?.slug, "atelier-clairiere");
    assert.equal(payload.publications[0]?.statut, "candidate");
    assert.deepEqual(payload.publications[0]?.source_donnees, [
      "saisie manuelle",
      "catalogue interne NovaLuth",
    ]);
    assert.equal(payload.publications[0]?.demonstration, false);

    const adminResponse = await fetch(`${apiOrigin}/api/admin/summary`, {
      headers: { "X-Admin-Token": "demo-admin" },
    });
    assert.equal(adminResponse.status, 200);
    const adminSummary = (await adminResponse.json()) as {
      fiches: Array<Record<string, unknown>>;
    };
    const candidate = adminSummary.fiches.find((fiche) => fiche.slug === "atelier-clairiere");
    assert.equal(candidate?.statut, "candidate");
    assert.deepEqual(candidate?.source_donnees, [
      "saisie manuelle",
      "catalogue interne NovaLuth",
    ]);
    assert.equal(candidate?.provenance_facons, "saisie manuelle");
  } finally {
    setSn13ClientFactoryForTests(null);
    if (previousGatewaySecret === undefined) delete process.env.NOVALUTH_GATEWAY_SECRET;
    else process.env.NOVALUTH_GATEWAY_SECRET = previousGatewaySecret;
    if (previousSn13Key === undefined) delete process.env.SN13_API_KEY;
    else process.env.SN13_API_KEY = previousSn13Key;
  }
});
