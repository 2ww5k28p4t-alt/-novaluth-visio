import pg from "pg";

const { Pool } = pg;

const schemaSyncCommand = "pnpm --filter @workspace/db run push";

export const expectedSn13Tables = [
  "novaluth_sn13_diagnostics",
  "novaluth_sn13_call_events",
  "novaluth_sn13_alert_state",
  "novaluth_sn13_purge_incidents",
] as const;

export const expectedSn13Constraints = [
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

export const expectedNonSn13Constraints = [
  {
    tableName: "novaluth_access_requests",
    name: "novaluth_access_requests_lifecycle_check",
    definition:
      "CHECK (((status = 'en_attente'::text) AND (payment_status = 'preautorise'::text) AND (decided_at IS NULL) AND (access_ends_at IS NULL)) OR ((status = 'acceptee'::text) AND (payment_status = 'encaisse'::text) AND (decided_at IS NOT NULL) AND (access_ends_at IS NOT NULL)) OR ((status = ANY (ARRAY['refusee'::text, 'annulee'::text])) AND (payment_status = 'annule'::text) AND (decided_at IS NOT NULL) AND (access_ends_at IS NULL)) OR ((status = 'expiree'::text) AND (payment_status = 'encaisse'::text) AND (decided_at IS NOT NULL) AND (access_ends_at IS NOT NULL)))",
  },
  {
    tableName: "novaluth_access_requests",
    name: "novaluth_access_requests_plan_check",
    definition:
      "CHECK (((plan = 'essentiel'::text) AND (amount_cents = 999) AND (followup_credits >= 0) AND (followup_credits <= 1)) OR ((plan = 'atelier'::text) AND (amount_cents = 1599) AND (followup_credits >= 0) AND (followup_credits <= 2)) OR ((plan = 'signature'::text) AND (amount_cents = 2499) AND (followup_credits >= 0) AND (followup_credits <= 3)))",
  },
  {
    tableName: "novaluth_email_outbox",
    name: "novaluth_email_outbox_status_check",
    definition:
      "CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'dead'::text])))",
  },
  {
    tableName: "novaluth_email_outbox",
    name: "novaluth_email_outbox_attempts_check",
    definition: "CHECK ((attempts >= 0))",
  },
] as const;

export const expectedNamedCheckConstraints = [
  ...expectedSn13Constraints,
  ...expectedNonSn13Constraints,
] as const;

const expectedConstraintTables = [
  ...new Set(expectedNamedCheckConstraints.map(({ tableName }) => tableName)),
];

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

function findMatchingParenthesis(value: string, openingIndex: number) {
  let depth = 0;
  let quote: "'" | '"' | undefined;

  for (let index = openingIndex; index < value.length; index += 1) {
    const character = value[index];

    if (quote) {
      if (character === quote) {
        if (value[index + 1] === quote) {
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function stripOuterParentheses(value: string) {
  let normalized = value.trim();

  while (
    normalized.startsWith("(") &&
    findMatchingParenthesis(normalized, 0) === normalized.length - 1
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized;
}

function stripRedundantGroupingParentheses(value: string) {
  let normalized = value;
  let changed = true;

  while (changed) {
    changed = false;
    const openings: number[] = [];

    for (let index = 0; index < normalized.length; index += 1) {
      if (normalized[index] === "(") {
        openings.push(index);
        continue;
      }

      if (normalized[index] !== ")" || openings.length === 0) continue;

      const openingIndex = openings.pop()!;
      const inner = normalized.slice(openingIndex + 1, index);
      const previousCharacter = normalized[openingIndex - 1];

      // Keep function calls and PostgreSQL's ANY(...) wrapper intact. Only
      // remove parentheses around boolean/comparison expressions that
      // pg_get_constraintdef adds while preserving the expression's meaning.
      if (
        /(?:\band\b|\bor\b|\bis\s+(?:not\s+)?null\b|<>|!=|<=|>=|=|<|>)/.test(
          inner,
        ) &&
        !/[a-z0-9_$]/.test(previousCharacter ?? "")
      ) {
        normalized =
          normalized.slice(0, openingIndex) +
          inner +
          normalized.slice(index + 1);
        changed = true;
        break;
      }
    }
  }

  return normalized;
}

function normalizeBetweenExpressions(value: string) {
  return value.replace(
    /(\b[a-z_][a-z0-9_$]*\b)\s+between\s+(-?[0-9]+|'[^']*')\s+and\s+(-?[0-9]+|'[^']*')/g,
    "$1 >= $2 and $1 <= $3",
  );
}

/**
 * Normalize Drizzle-rendered CHECK expressions and pg_get_constraintdef()
 * output to the same PostgreSQL expression form. PostgreSQL adds CHECK and
 * redundant grouping parentheses, removes table qualification, renders an
 * IN list as = ANY (ARRAY[...]), and annotates text literals with ::text.
 * It also renders BETWEEN as two comparisons. These transformations keep the
 * drift check independent of a database.
 */
export function normalizeDefinition(definition: string) {
  let normalized = normalizeBetweenExpressions(
    definition.replace(/\s+/g, " ").trim().toLowerCase(),
  );

  if (normalized.startsWith("check")) {
    normalized = normalized.slice("check".length).trim();
  }

  normalized = stripOuterParentheses(normalized)
    .replace(/"[^"]+"\."([^"]+)"/g, "$1")
    .replace(/"([^"]+)"/g, "$1")
    .replace(/\bin\s*\(([^()]*)\)/g, "= any (array[$1])")
    .replace(/::text\b/g, "");

  normalized = normalizeBetweenExpressions(normalized);

  return stripRedundantGroupingParentheses(stripOuterParentheses(normalized));
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
      ["public", expectedConstraintTables],
    );
    const actualConstraints = new Map(
      constraintResult.rows.map((row) => [
        `${row.table_name}.${row.constraint_name}`,
        row,
      ]),
    );
    const missingConstraints: string[] = [];
    const mismatchedConstraints: Sn13SchemaDrift["mismatchedConstraints"] = [];

    for (const expected of expectedNamedCheckConstraints) {
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
