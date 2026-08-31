import { pool } from "@workspace/db";
import {
  lastSn13Call,
  requestDataUniverse,
  setSn13ClientFactoryForTests,
} from "../gateway/provider-registry";

const mode = process.argv[2];
const requestId = process.env.SN13_DIAGNOSTIC_TEST_REQUEST_ID;
const apiKey = process.env.SN13_DIAGNOSTIC_TEST_SECRET;

if (!requestId || !apiKey) {
  throw new Error("Les paramètres du processus SN13 de test sont requis.");
}

const request = {
  source: "X" as const,
  usernames: [],
  keywords: ["lutherie"],
  startDate: "2026-03-01",
  endDate: "2026-08-31",
  limit: 100,
  keywordMode: "any" as const,
};

try {
  if (mode === "write") {
    process.env.NODE_ENV = "test";
    process.env.SN13_API_KEY = apiKey;
    setSn13ClientFactoryForTests(() => ({
      onDemandData: async () => ({
        status: "error",
        data: [],
        meta: {
          request_id: requestId,
          detail: `upstream failed with api_key=${apiKey}`,
          authorization: `Bearer ${apiKey}`,
        },
      }),
    }));
    await requestDataUniverse(request);
  } else if (mode !== "read") {
    throw new Error(`Mode de processus SN13 inconnu: ${mode}`);
  }

  const state = await lastSn13Call();
  process.stdout.write(
    JSON.stringify({
      statut: state.statut,
      requete_id: state.requete_id,
      appele_le: state.appele_le,
      corps_erreur: state.corps_erreur,
    }),
  );
} finally {
  setSn13ClientFactoryForTests(null);
  await pool.end();
}
