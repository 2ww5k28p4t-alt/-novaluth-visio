import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sendNovaLuthEmail } from "./novaluth-email";

const nativeFetch = globalThis.fetch;
const originalConfig = {
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.NOVALUTH_EMAIL_FROM,
};
let sentBody: { subject?: string; html?: string; text?: string } | undefined;

before(() => {
  process.env.RESEND_API_KEY = "re_test_sn13_alert";
  process.env.NOVALUTH_EMAIL_FROM = "NovaLuth <notifications@example.test>";
  globalThis.fetch = async (_input, init) => {
    sentBody = JSON.parse(String(init?.body)) as typeof sentBody;
    return new Response(JSON.stringify({ id: "email_sn13_test" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
});

after(() => {
  globalThis.fetch = nativeFetch;
  if (originalConfig.apiKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalConfig.apiKey;
  if (originalConfig.from === undefined) delete process.env.NOVALUTH_EMAIL_FROM;
  else process.env.NOVALUTH_EMAIL_FROM = originalConfig.from;
});

test("SN13 alert email contains only provider, window, and counters", async () => {
  await sendNovaLuthEmail("equipe@example.test", {
    event: "sn13_degradation",
    reference: "SN13",
    portalUrl: "",
    sn13: {
      provider: "Data Universe",
      windowHours: 24,
      total: 5,
      success: 1,
      empty: 1,
      incomplete: 2,
      error: 1,
    },
  });

  assert.equal(sentBody?.subject, "Alerte SN13 · Data Universe");
  assert.match(sentBody?.text ?? "", /Fournisseur : Data Universe/);
  assert.match(sentBody?.text ?? "", /Fenêtre : 24 heures/);
  assert.match(
    sentBody?.text ?? "",
    /total 5, succès 1, vides 1, incomplètes 2, erreurs 1/,
  );
  assert.doesNotMatch(
    sentBody?.text ?? "",
    /SN13-REQUEST|api[_-]?key|secret|Bearer/i,
  );
  assert.doesNotMatch(sentBody?.html ?? "", /portail|Référence|https?:\/\//i);
});

test("SN13 purge failure email identifies the failed maintenance", async () => {
  await sendNovaLuthEmail("equipe@example.test", {
    event: "sn13_purge_failure",
    reference: "SN13",
    portalUrl: "",
    sn13Purge: {
      provider: "Data Universe",
      windowHours: 24,
    },
  });

  assert.equal(sentBody?.subject, "Échec de purge SN13 · Data Universe");
  assert.match(sentBody?.text ?? "", /Purge SN13 en échec/);
  assert.match(
    sentBody?.text ?? "",
    /La purge planifiée de l’historique SN13 a échoué/,
  );
  assert.doesNotMatch(sentBody?.html ?? "", /portail|Référence|https?:\/\//i);
});
