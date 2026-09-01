import pg from "pg";

const { Pool } = pg;

const schemaSyncCommand = "pnpm --filter @workspace/db run push";

const expectedSn13Tables = [
  "novaluth_sn13_diagnostics",
  "novaluth_sn13_call_events",
  "novaluth_sn13_alert_state",
  "novaluth_sn13_purge_incidents",
] as const;

const expectedSn13Constraints = [
  {
    tableName: "novaluth_sn13_diagnostics",
    name: "novaluth_sn13_diagnostics_status_check",
    definition:
      "CHECK ((status = ANY (ARRAY['succes'::text, 'vide'::text, 'incomplet'::text, 'erreur'::text])))",
  },
  {
    tableName: "novaluth_sn13_diagnostics",
    name: "novaluth_sn13_diagnostics_request_id_length_check",
    definition:
      "CHECK (((request_id IS NULL) OR (char_length(request_id) <= 200)))",
  },
  {
    tableName: "novaluth_sn13_diagnostics",
    name: "novaluth_sn13_diagnostics_error_body_length_check",
    definition:
      "CHECK (((error_body IS NULL) OR (char_length(error_body) <= 4000)))",
  },
  {
    tableName: "novaluth_sn13_diagnostics",
    name: "novaluth_sn13_diagnostics_result_count_check",
    definition: "CHECK (((result_count IS NULL) OR (result_count >= 0)))",
  },
  {
    tableName: "novaluth_sn13_call_events",
    name: "novaluth_sn13_call_events_status_check",
    definition:
      "CHECK ((status = ANY (ARRAY['succes'::text, 'vide'::text, 'incomplet'::text, 'erreur'::text])))",
  },
] as const;

export type Sn13SchemaQuery = (
  text: string,
  values: [string, string[]],
) => Promise<{ rows: Array<Record<string, string>> }>;

export type Sn13SchemaDrift = {
  missingTables: string[];
  missingConstraints: string[];
  mismatchedConstraints: Array<{
    name: string;
    expected: string;
    actual: string;
  }>;
};

function normalizeDefinition(definition: string) {
  return definition.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function findSn13SchemaDrift(
  queryOverride?: Sn13SchemaQuery,
): Promise<Sn13SchemaDrift> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Le contrôle du schéma SN13 est réservé à la base de développement et refuse NODE_ENV=production.",
    );
  }

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL doit pointer vers la base de développement pour contrôler le schéma SN13.",
    );
  }

  const checkPool = queryOverride
    ? undefined
    : new Pool({ connectionString: process.env.DATABASE_URL });
  const query: Sn13SchemaQuery =
    queryOverride ?? ((text, values) => checkPool!.query(text, values));

  try {
    const tableResult = await query(
      `select table_name
         from information_schema.tables
        where table_schema = $1
          and table_type = 'BASE TABLE'
          and table_name = any($2::text[])`,
      ["public", [...expectedSn13Tables]],
    );
    const actualTables = new Set(tableResult.rows.map((row) => row.table_name));
    const missingTables = expectedSn13Tables.filter(
      (tableName) => !actualTables.has(tableName),
    );

    const constraintResult = await query(
      `select c.relname as table_name,
              con.conname as constraint_name,
              pg_get_constraintdef(con.oid) as definition
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1
          and c.relname = any($2::text[])
          and con.contype = 'c'`,
      ["public", [...expectedSn13Tables]],
    );
    const actualConstraints = new Map(
      constraintResult.rows.map((row) => [
        `${row.table_name}.${row.constraint_name}`,
        row,
      ]),
    );
    const missingConstraints: string[] = [];
    const mismatchedConstraints: Sn13SchemaDrift["mismatchedConstraints"] = [];

    for (const expected of expectedSn13Constraints) {
      const actual = actualConstraints.get(
        `${expected.tableName}.${expected.name}`,
      );
      if (!actual) {
        missingConstraints.push(expected.name);
        continue;
      }

      if (
        normalizeDefinition(actual.definition) !==
        normalizeDefinition(expected.definition)
      ) {
        mismatchedConstraints.push({
          name: expected.name,
          expected: expected.definition,
          actual: actual.definition,
        });
      }
    }

    return {
      missingTables,
      missingConstraints,
      mismatchedConstraints,
    };
  } finally {
    await checkPool?.end();
  }
}

function hasDrift(drift: Sn13SchemaDrift) {
  return (
    drift.missingTables.length > 0 ||
    drift.missingConstraints.length > 0 ||
    drift.mismatchedConstraints.length > 0
  );
}

export async function assertSn13SchemaSynchronized(
  queryOverride?: Sn13SchemaQuery,
) {
  const drift = await findSn13SchemaDrift(queryOverride);
  if (!hasDrift(drift)) return;

  const details = [
    drift.missingTables.length > 0
      ? `Tables absentes : ${drift.missingTables.join(", ")}.`
      : "",
    drift.missingConstraints.length > 0
      ? `Contraintes absentes : ${drift.missingConstraints.join(", ")}.`
      : "",
    ...drift.mismatchedConstraints.map(
      ({ name, expected, actual }) =>
        `Contrainte obsolète ${name} : attendue ${expected}, trouvée ${actual}.`,
    ),
  ].filter(Boolean);

  throw new Error(
    [
      "Dérive du schéma SN13 détectée dans la base de développement.",
      ...details,
      `Exécutez \`${schemaSyncCommand}\`, puis relancez le contrôle.`,
      "Ce contrôle est en lecture seule et ne modifie jamais la base de production.",
    ].join("\n"),
  );
}

async function main() {
  try {
    await assertSn13SchemaSynchronized();
    console.log("Schéma SN13 synchronisé avec la base de développement.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("/schema-check.ts")) {
  void main();
}
