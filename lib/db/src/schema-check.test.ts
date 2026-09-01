import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  assertSn13SchemaSynchronized,
  type Sn13SchemaQuery,
} from "./schema-check";

const originalNodeEnv = process.env.NODE_ENV;
const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;

  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function runWithDevelopmentEnvironment<T>(callback: () => Promise<T>) {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgresql://schema-check-test.invalid/database";
  return callback();
}

function createQueryStub({
  tables,
  constraints,
}: {
  tables: Array<Record<string, string>>;
  constraints: Array<Record<string, string>>;
}): Sn13SchemaQuery {
  return async (text) => {
    if (text.includes("information_schema.tables")) {
      return { rows: tables };
    }

    if (text.includes("pg_constraint")) {
      return { rows: constraints };
    }

    throw new Error(`Unexpected schema query: ${text}`);
  };
}

test("identifies a missing SN13 table in the synchronization failure", async () => {
  const query = createQueryStub({
    tables: [
      { table_name: "novaluth_sn13_diagnostics" },
      { table_name: "novaluth_sn13_call_events" },
      { table_name: "novaluth_sn13_purge_incidents" },
    ],
    constraints: [],
  });

  await runWithDevelopmentEnvironment(async () => {
    await assert.rejects(
      assertSn13SchemaSynchronized(query),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(
          error.message,
          /Tables absentes : novaluth_sn13_alert_state\./,
        );
        assert.match(error.message, /pnpm --filter @workspace\/db run push/);
        return true;
      },
    );
  });
});

test("shows the synchronization command for an outdated SN13 CHECK definition", async () => {
  const query = createQueryStub({
    tables: [
      { table_name: "novaluth_sn13_diagnostics" },
      { table_name: "novaluth_sn13_call_events" },
      { table_name: "novaluth_sn13_alert_state" },
      { table_name: "novaluth_sn13_purge_incidents" },
    ],
    constraints: [
      {
        table_name: "novaluth_sn13_diagnostics",
        constraint_name: "novaluth_sn13_diagnostics_status_check",
        definition:
          "CHECK ((status = ANY (ARRAY['success'::text, 'vide'::text])))",
      },
    ],
  });

  await runWithDevelopmentEnvironment(async () => {
    await assert.rejects(
      assertSn13SchemaSynchronized(query),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(
          error.message,
          /Contrainte obsolète novaluth_sn13_diagnostics_status_check/,
        );
        assert.match(
          error.message,
          /Exécutez `pnpm --filter @workspace\/db run push`, puis relancez le contrôle\./,
        );
        return true;
      },
    );
  });
});
