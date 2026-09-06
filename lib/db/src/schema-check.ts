import pg from "pg";
import { readFile } from "node:fs/promises";
import {
  getTableConfig,
  PgDialect,
  PgTable,
  type AnyPgTable,
} from "drizzle-orm/pg-core";
import * as sourceSchema from "./schema";

const { Pool } = pg;

const schemaSyncCommand = "pnpm --filter @workspace/db run push";
const developmentDatabaseMessage =
  "Ce contrôle est réservé à la base de développement et refuse NODE_ENV=production.";

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

const schemaDialect = new PgDialect();
export const expectedProspectionConstraints = Object.values(sourceSchema)
  .filter((value) => value instanceof PgTable)
  .map((table) => getTableConfig(table as AnyPgTable))
  .filter(({ name }) => name.startsWith("prospection_"))
  .flatMap(({ name: tableName, checks }) =>
    checks.map(({ name, value }) => ({
      tableName,
      name,
      definition: schemaDialect.sqlToQuery(value).sql,
    })),
  );

export const expectedNonSn13Constraints = [
  {
    tableName: "novaluth_platform_accounts",
    name: "novaluth_platform_accounts_role_check",
    definition:
      "CHECK ((role = ANY (ARRAY['admin'::text, 'artisan'::text, 'musicien'::text])))",
  },
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
    tableName: "novaluth_protected_orders",
    name: "novaluth_protected_orders_status_check",
    definition:
      "CHECK ((status = ANY (ARRAY['declaree'::text, 'confirmee'::text, 'expiree'::text, 'refusee'::text, 'annulee_client'::text, 'annulee_atelier'::text, 'livree'::text, 'non_confirmee'::text])))",
  },
  {
    tableName: "novaluth_protected_orders",
    name: "novaluth_protected_orders_money_check",
    definition:
      "CHECK (((price_cents > 0) AND (deposit_cents >= 0) AND (deposit_cents <= price_cents) AND (commitment_fee_cents = 2900) AND ((commission_cents >= 0) AND (commission_cents <= 14900))))",
  },
  {
    tableName: "novaluth_protected_orders",
    name: "novaluth_protected_orders_payment_check",
    definition:
      "CHECK (((commitment_payment_status = ANY (ARRAY['non_du'::text, 'encaisse'::text, 'credit_utilise'::text])) AND (commission_payment_status = ANY (ARRAY['non_due'::text, 'encaisse'::text]))))",
  },
  {
    tableName: "novaluth_protected_order_credits",
    name: "novaluth_protected_order_credits_amount_check",
    definition: "CHECK ((amount_cents = 2900))",
  },
  {
    tableName: "novaluth_protected_order_credits",
    name: "novaluth_protected_order_credits_status_check",
    definition:
      "CHECK ((status = ANY (ARRAY['disponible'::text, 'utilise'::text])))",
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
  ...expectedProspectionConstraints,
] as const;

export const expectedNamedCheckConstraints = [
  ...expectedSn13Constraints,
  ...expectedNonSn13Constraints,
] as const;

const expectedConstraintTables = [
  ...new Set(expectedNamedCheckConstraints.map(({ tableName }) => tableName)),
];

export const expectedSourceTables = Object.values(sourceSchema)
  .filter((value) => value instanceof PgTable)
  .map((table) => getTableConfig(table as AnyPgTable).name)
  .sort();

export type Sn13SchemaQuery = (
  text: string,
  values?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export type Sn13SchemaDrift = {
  missingTables: string[];
  missingConstraints: Array<{
    tableName: string;
    name: string;
  }>;
  mismatchedConstraints: Array<{
    tableName: string;
    name: string;
    expected: string;
    actual: string;
  }>;
};

export type OrphanedTable = {
  tableName: string;
  rowCount: number;
};

export type OrphanedTablesReport = {
  schemaName: "public";
  sourceTables: string[];
  orphanedTables: OrphanedTable[];
  reviewRequired: boolean;
};

export type OrphanedTableReview = {
  reviewedAt: string;
  reviewer: string;
  decisions: Array<{
    tableName: string;
    action: "retain" | "drop";
    reason: string;
  }>;
};

const orphanReviewFileEnvironmentVariable = "SCHEMA_ORPHAN_REVIEW_FILE";

function assertDevelopmentEnvironment() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(developmentDatabaseMessage);
  }

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL doit pointer vers la base de développement pour contrôler le schéma.",
    );
  }
}

function parseRowCount(value: unknown, tableName: string) {
  const rowCount = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error(
      `Le nombre de lignes de la table ${tableName} est invalide : ${String(value)}.`,
    );
  }
  return rowCount;
}

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
    let quote: "'" | '"' | undefined;

    for (let index = 0; index < normalized.length; index += 1) {
      const character = normalized[index];

      if (quote) {
        if (character === quote) {
          if (normalized[index + 1] === quote) {
            index += 1;
          } else {
            quote = undefined;
          }
        }
        continue;
      }

      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }

      if (character === "(") {
        openings.push(index);
        continue;
      }

      if (character !== ")" || openings.length === 0) continue;

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
  assertDevelopmentEnvironment();

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
        {
          tableName: String(row.table_name ?? ""),
          constraintName: String(row.constraint_name ?? ""),
          definition: String(row.definition ?? ""),
        },
      ]),
    );
    const missingConstraints: Sn13SchemaDrift["missingConstraints"] = [];
    const mismatchedConstraints: Sn13SchemaDrift["mismatchedConstraints"] = [];

    for (const expected of expectedNamedCheckConstraints) {
      const actual = actualConstraints.get(
        `${expected.tableName}.${expected.name}`,
      );
      if (!actual) {
        missingConstraints.push({
          tableName: expected.tableName,
          name: expected.name,
        });
        continue;
      }

      if (
        normalizeDefinition(actual.definition) !==
        normalizeDefinition(expected.definition)
      ) {
        mismatchedConstraints.push({
          tableName: expected.tableName,
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

/**
 * Find public PostgreSQL tables that are not represented in the current
 * Drizzle source schema. The row count is evaluated by PostgreSQL for each
 * table, rather than relying on planner statistics, so a cleanup review sees
 * the data that would actually be affected.
 */
export async function findOrphanedTables(
  queryOverride?: Sn13SchemaQuery,
): Promise<OrphanedTablesReport> {
  assertDevelopmentEnvironment();

  const checkPool = queryOverride
    ? undefined
    : new Pool({ connectionString: process.env.DATABASE_URL });
  const query: Sn13SchemaQuery =
    queryOverride ?? ((text, values) => checkPool!.query(text, values));

  try {
    const result = await query(
      `select tables.table_name,
              (xpath(
                '/row/count/text()',
                query_to_xml(
                  format('select count(*) as count from %I.%I', tables.table_schema, tables.table_name),
                  false,
                  true,
                  ''
                )
              ))[1]::text::bigint as row_count
         from information_schema.tables tables
        where tables.table_schema = $1
          and tables.table_type = 'BASE TABLE'
          and tables.table_name <> all($2::text[])
        order by tables.table_name`,
      ["public", expectedSourceTables],
    );

    const orphanedTables = result.rows.map((row) => {
      const tableName = String(row.table_name ?? "");
      if (!tableName) {
        throw new Error(
          "Le contrôle des tables orphelines a reçu un nom vide.",
        );
      }

      return {
        tableName,
        rowCount: parseRowCount(row.row_count, tableName),
      };
    });

    return {
      schemaName: "public",
      sourceTables: [...expectedSourceTables],
      orphanedTables,
      reviewRequired: orphanedTables.length > 0,
    };
  } finally {
    await checkPool?.end();
  }
}

export function formatOrphanedTablesReport(report: OrphanedTablesReport) {
  if (report.orphanedTables.length === 0) {
    return "Aucune table orpheline détectée dans la base de développement.";
  }

  return [
    "Tables présentes dans PostgreSQL mais absentes du schéma Drizzle :",
    ...report.orphanedTables.map(
      ({ tableName, rowCount }) =>
        `- ${tableName} : ${rowCount} ligne${rowCount === 1 ? "" : "s"}.`,
    ),
    "Aucune suppression n'a été exécutée.",
    "Une revue explicite est requise avant toute suppression de ces tables.",
  ].join("\n");
}

/**
 * Validate the signed-off record required by any future destructive cleanup.
 * This function intentionally does not mutate the database.
 */
export function assertOrphanedTableCleanupReviewed(
  report: OrphanedTablesReport,
  review?: OrphanedTableReview,
) {
  if (report.orphanedTables.length === 0) return;

  if (!review) {
    throw new Error(
      "Une revue explicite des tables orphelines est requise avant toute suppression.",
    );
  }

  if (!review.reviewer.trim() || !review.reviewedAt.trim()) {
    throw new Error(
      "Le relevé de revue des tables orphelines doit contenir un reviewer et une date.",
    );
  }

  const orphanedTableNames = new Set(
    report.orphanedTables.map(({ tableName }) => tableName),
  );
  const reviewedTableNames = new Set<string>();

  for (const decision of review.decisions) {
    if (
      !orphanedTableNames.has(decision.tableName) ||
      reviewedTableNames.has(decision.tableName)
    ) {
      throw new Error(
        `Le relevé de revue contient une table inattendue ou dupliquée : ${decision.tableName}.`,
      );
    }
    if (!decision.reason.trim()) {
      throw new Error(
        `La décision de revue pour ${decision.tableName} doit préciser une raison.`,
      );
    }
    if (decision.action !== "retain" && decision.action !== "drop") {
      throw new Error(
        `L'action de revue pour ${decision.tableName} est invalide : ${decision.action}.`,
      );
    }
    reviewedTableNames.add(decision.tableName);
  }

  if (reviewedTableNames.size !== orphanedTableNames.size) {
    const missingTables = [...orphanedTableNames].filter(
      (tableName) => !reviewedTableNames.has(tableName),
    );
    throw new Error(
      `Le relevé de revue ne couvre pas toutes les tables orphelines : ${missingTables.join(", ")}.`,
    );
  }
}

export async function loadOrphanedTableReview(
  reviewFile = process.env[orphanReviewFileEnvironmentVariable],
): Promise<OrphanedTableReview | undefined> {
  if (!reviewFile) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(reviewFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Impossible de lire le relevé de revue ${reviewFile} : ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).reviewedAt !== "string" ||
    typeof (parsed as Record<string, unknown>).reviewer !== "string" ||
    !Array.isArray((parsed as Record<string, unknown>).decisions) ||
    !(parsed as Record<string, unknown[]>).decisions.every(
      (decision) =>
        Boolean(decision) &&
        typeof decision === "object" &&
        typeof (decision as Record<string, unknown>).tableName === "string" &&
        typeof (decision as Record<string, unknown>).action === "string" &&
        typeof (decision as Record<string, unknown>).reason === "string",
    )
  ) {
    throw new Error(
      `Le relevé de revue ${reviewFile} est incomplet ou invalide.`,
    );
  }

  return parsed as OrphanedTableReview;
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
      ? `Contraintes absentes : ${drift.missingConstraints
          .map(({ tableName, name }) => `${tableName}.${name}`)
          .join(", ")}.`
      : "",
    ...drift.mismatchedConstraints.map(
      ({ tableName, name, expected, actual }) =>
        `Contrainte obsolète ${tableName}.${name} : attendue ${expected}, trouvée ${actual}.`,
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

export async function runSchemaCheck(
  args = process.argv.slice(2),
  queryOverride?: Sn13SchemaQuery,
) {
  if (args.includes("--before-push")) {
    const report = await findOrphanedTables(queryOverride);
    const formattedReport = formatOrphanedTablesReport(report);

    if (report.reviewRequired) {
      const review = await loadOrphanedTableReview();
      try {
        assertOrphanedTableCleanupReviewed(report, review);
      } catch (error) {
        throw new Error(
          [
            formattedReport,
            error instanceof Error ? error.message : String(error),
            `Renseignez ${orphanReviewFileEnvironmentVariable} avec le chemin d'un relevé JSON complet avant de relancer le push.`,
          ].join("\n"),
        );
      }
    }

    return report.reviewRequired
      ? `${formattedReport}\nRevue des tables orphelines validée. Le push peut présenter les changements.`
      : formattedReport;
  }

  if (args.includes("--orphans")) {
    const report = await findOrphanedTables(queryOverride);
    if (report.reviewRequired) {
      throw new Error(formatOrphanedTablesReport(report));
    }
    return formatOrphanedTablesReport(report);
  }

  await assertSn13SchemaSynchronized(queryOverride);
  return "Schéma SN13 synchronisé avec la base de développement.";
}

async function main() {
  try {
    console.log(await runSchemaCheck());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("/schema-check.ts")) {
  void main();
}
