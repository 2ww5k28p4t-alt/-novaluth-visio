import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  getTableConfig,
  PgDialect,
  PgTable,
  type AnyPgTable,
} from "drizzle-orm/pg-core";

import {
  assertSn13SchemaSynchronized,
  expectedNamedCheckConstraints,
  expectedNonSn13Constraints,
  expectedSn13Constraints,
  expectedSn13Tables,
  normalizeDefinition,
  type Sn13SchemaQuery,
} from "./schema-check";
import * as sourceSchema from "./schema";

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

test("keeps SN13 preflight expectations aligned with the source schema", () => {
  const dialect = new PgDialect();
  const sourceTables = Object.values(sourceSchema)
    .filter((value) => value instanceof PgTable)
    .map((table) => getTableConfig(table as AnyPgTable));
  const sourceSn13Tables = sourceTables.filter(({ name }) =>
    name.startsWith("novaluth_sn13_"),
  );

  assert.deepEqual(
    [...expectedSn13Tables].sort(),
    sourceSn13Tables.map(({ name }) => name).sort(),
  );

  const sourceConstraints = sourceTables.flatMap(({ name, checks }) =>
    checks.map((check) => ({
      key: `${name}.${check.name}`,
      definition: dialect.sqlToQuery(check.value).sql,
    })),
  );
  const expectedConstraintNames = expectedNamedCheckConstraints.map(
    ({ tableName, name }) => `${tableName}.${name}`,
  );

  assert.deepEqual(
    expectedConstraintNames.sort(),
    sourceConstraints.map(({ key }) => key).sort(),
  );

  const expectedByName = new Map<
    string,
    (typeof expectedNamedCheckConstraints)[number]
  >(
    expectedNamedCheckConstraints.map((constraint) => [
      `${constraint.tableName}.${constraint.name}`,
      constraint,
    ]),
  );
  for (const sourceConstraint of sourceConstraints) {
    const expected = expectedByName.get(sourceConstraint.key);
    assert.ok(
      expected,
      `Unexpected named CHECK constraint ${sourceConstraint.key}`,
    );
    assert.equal(
      normalizeDefinition(sourceConstraint.definition),
      normalizeDefinition(expected.definition),
      `CHECK definition mismatch for ${sourceConstraint.key}`,
    );
  }
});

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

test("identifies a missing named SN13 CHECK constraint in the synchronization failure", async () => {
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
          "CHECK ((status = ANY (ARRAY['succes'::text, 'vide'::text, 'incomplet'::text, 'erreur'::text])))",
      },
      {
        table_name: "novaluth_sn13_diagnostics",
        constraint_name: "novaluth_sn13_diagnostics_request_id_length_check",
        definition:
          "CHECK (((request_id IS NULL) OR (char_length(request_id) <= 200)))",
      },
      {
        table_name: "novaluth_sn13_diagnostics",
        constraint_name: "novaluth_sn13_diagnostics_error_body_length_check",
        definition:
          "CHECK (((error_body IS NULL) OR (char_length(error_body) <= 4000)))",
      },
      {
        table_name: "novaluth_sn13_diagnostics",
        constraint_name: "novaluth_sn13_diagnostics_result_count_check",
        definition: "CHECK (((result_count IS NULL) OR (result_count >= 0)))",
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
          /Contraintes absentes : .*novaluth_sn13_call_events_status_check/,
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

test("identifies an outdated non-SN13 CHECK constraint by name", async () => {
  const query = createQueryStub({
    tables: [
      { table_name: "novaluth_sn13_diagnostics" },
      { table_name: "novaluth_sn13_call_events" },
      { table_name: "novaluth_sn13_alert_state" },
      { table_name: "novaluth_sn13_purge_incidents" },
      { table_name: "novaluth_access_requests" },
      { table_name: "novaluth_email_outbox" },
    ],
    constraints: [
      {
        table_name: "novaluth_email_outbox",
        constraint_name: "novaluth_email_outbox_status_check",
        definition:
          "CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text])))",
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
          /Contrainte obsolète novaluth_email_outbox_status_check/,
        );
        return true;
      },
    );
  });
});

test("keeps non-SN13 constraint expectations separate from SN13 constraints", () => {
  assert.equal(expectedNonSn13Constraints.length, 4);
  assert.equal(expectedSn13Constraints.length, 5);
  assert.equal(expectedNamedCheckConstraints.length, 9);
});
