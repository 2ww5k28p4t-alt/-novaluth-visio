import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import app from "../app";
import { anonymize } from "./anonymize";
import { activeProviders } from "./provider-registry";
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
