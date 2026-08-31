import { pool } from "@workspace/db";
import {
  lastSn13Call,
  requestDataUniverse,
  setSn13ClockForTests,
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
    const status = process.env.SN13_DIAGNOSTIC_TEST_STATUS ?? "erreur";
    const calledAt = Number(process.env.SN13_DIAGNOSTIC_TEST_CALLED_AT);
    const callCountValue = Number(process.env.SN13_DIAGNOSTIC_TEST_CALLS);
    const callCount =
      Number.isFinite(callCountValue) && callCountValue > 0
        ? Math.floor(callCountValue)
        : 1;
    const betweenCallsDelayValue = Number(
      process.env.SN13_DIAGNOSTIC_TEST_BETWEEN_CALLS_DELAY_MS,
    );
    const betweenCallsDelay =
      Number.isFinite(betweenCallsDelayValue) && betweenCallsDelayValue > 0
        ? betweenCallsDelayValue
        : 0;
    let callIndex = 0;
    if (Number.isFinite(calledAt)) {
      setSn13ClockForTests(() => calledAt);
    }
    setSn13ClientFactoryForTests(() => ({
      onDemandData: async () => ({
        status:
          status === "incomplet"
            ? "success"
            : status === "erreur"
              ? "error"
              : "success",
        data:
          status === "incomplet"
            ? (undefined as never)
            : status === "vide"
              ? []
              : [{ request_id: requestId }],
        meta: {
          request_id: callCount > 1 ? `${requestId}-${callIndex++}` : requestId,
          detail: `upstream failed for request=${requestId} with api_key=${apiKey}`,
          authorization: `Bearer ${apiKey}`,
        },
      }),
    }));
    const delayMs = Number(process.env.SN13_DIAGNOSTIC_TEST_WRITE_DELAY_MS);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    for (let callIndex = 0; callIndex < callCount; callIndex += 1) {
      await requestDataUniverse(request);
      if (callIndex < callCount - 1 && betweenCallsDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, betweenCallsDelay));
      }
    }
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
      recents: state.recents,
    }),
  );
} finally {
  if (mode === "write") setSn13ClockForTests(null);
  setSn13ClientFactoryForTests(null);
  await pool.end();
}
