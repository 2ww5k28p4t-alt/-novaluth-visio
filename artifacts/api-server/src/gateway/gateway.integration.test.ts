import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import app from "../app";
import { anonymize } from "./anonymize";
import { logger } from "../lib/logger";
import {
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

function originFor(server: Server) {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
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
      assert.deepEqual(result.publications, []);
      assert.equal(result.nombre, 0);
      assert.equal(result.etat_collecte, "indisponible");
      assert.equal(result.fournisseur, "local-collecte");
      assert.deepEqual(result.secours, ["data-universe"]);
    }
    assert.equal(
      afterSummary.compteurs.candidate,
      beforeSummary.compteurs.candidate,
      "La collecte en erreur ne doit créer aucune fiche candidate.",
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
