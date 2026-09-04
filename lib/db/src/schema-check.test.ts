import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  getTableConfig,
  PgDialect,
  PgTable,
  type AnyPgTable,
} from "drizzle-orm/pg-core";

import {
  assertSn13SchemaSynchronized,
  assertOrphanedTableCleanupReviewed,
  expectedNamedCheckConstraints,
  expectedNonSn13Constraints,
  expectedSourceTables,
  expectedSn13Constraints,
  expectedSn13Tables,
  findOrphanedTables,
  formatOrphanedTablesReport,
  normalizeDefinition,
  runSchemaCheck,
  type OrphanedTablesReport,
  type Sn13SchemaQuery,
} from "./schema-check";
import * as sourceSchema from "./schema";

const originalNodeEnv = process.env.NODE_ENV;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalOrphanReviewFile = process.env.SCHEMA_ORPHAN_REVIEW_FILE;
const execFileAsync = promisify(execFile);

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;

  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;

  if (originalOrphanReviewFile === undefined)
    delete process.env.SCHEMA_ORPHAN_REVIEW_FILE;
  else process.env.SCHEMA_ORPHAN_REVIEW_FILE = originalOrphanReviewFile;
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
  assert.deepEqual(
    [...expectedSourceTables],
    sourceTables.map(({ name }) => name).sort(),
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
          /Contrainte obsolète novaluth_sn13_diagnostics\.novaluth_sn13_diagnostics_status_check/,
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
          /Contraintes absentes : .*novaluth_sn13_call_events\.novaluth_sn13_call_events_status_check/,
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
          /Contrainte obsolète novaluth_email_outbox\.novaluth_email_outbox_status_check/,
        );
        return true;
      },
    );
  });
});

test("keeps non-SN13 constraint expectations separate from SN13 constraints", () => {
  assert.equal(expectedNonSn13Constraints.length, 10);
  assert.equal(expectedSn13Constraints.length, 5);
  assert.equal(expectedNamedCheckConstraints.length, 15);
});

test("finds development tables missing from the current Drizzle source schema with row counts", async () => {
  const query = async () => ({
    rows: [
      { table_name: "legacy_table", row_count: "3" },
      { table_name: "empty_legacy_table", row_count: 0 },
    ],
  });

  const report = await runWithDevelopmentEnvironment(() =>
    findOrphanedTables(query),
  );

  assert.deepEqual(report, {
    schemaName: "public",
    sourceTables: [...expectedSourceTables],
    orphanedTables: [
      { tableName: "legacy_table", rowCount: 3 },
      { tableName: "empty_legacy_table", rowCount: 0 },
    ],
    reviewRequired: true,
  });
});

test("reports that orphan cleanup is non-destructive and review-gated", () => {
  const report: OrphanedTablesReport = {
    schemaName: "public",
    sourceTables: [...expectedSourceTables],
    orphanedTables: [{ tableName: "legacy_table", rowCount: 3 }],
    reviewRequired: true,
  };

  assert.match(formatOrphanedTablesReport(report), /legacy_table : 3 lignes/);
  assert.match(
    formatOrphanedTablesReport(report),
    /Aucune suppression n'a été exécutée/,
  );
  assert.throws(
    () => assertOrphanedTableCleanupReviewed(report),
    /revue explicite.*requise/,
  );
  assert.throws(
    () =>
      assertOrphanedTableCleanupReviewed(report, {
        reviewedAt: "2026-09-02T18:00:00.000Z",
        reviewer: "schema-owner",
        decisions: [],
      }),
    /ne couvre pas toutes les tables/,
  );

  assert.doesNotThrow(() =>
    assertOrphanedTableCleanupReviewed(report, {
      reviewedAt: "2026-09-02T18:00:00.000Z",
      reviewer: "schema-owner",
      decisions: [
        {
          tableName: "legacy_table",
          action: "retain",
          reason: "Retention confirmed with the data owner.",
        },
      ],
    }),
  );
  assert.throws(
    () =>
      assertOrphanedTableCleanupReviewed(report, {
        reviewedAt: "2026-09-02T18:00:00.000Z",
        reviewer: "schema-owner",
        decisions: [
          {
            tableName: "legacy_table",
            action: "archive" as "retain",
            reason: "Unsupported action should never authorize cleanup.",
          },
        ],
      }),
    /action.*invalide/,
  );
});

test("does not require a cleanup review when no orphaned tables exist", () => {
  assert.doesNotThrow(() =>
    assertOrphanedTableCleanupReviewed({
      schemaName: "public",
      sourceTables: [...expectedSourceTables],
      orphanedTables: [],
      reviewRequired: false,
    }),
  );
});

test("wires normal and force pushes through their respective safety guards", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  const isolatedScript = await readFile(
    new URL("../scripts/check-schema-isolated.sh", import.meta.url),
    "utf8",
  );

  assert.match(packageJson.scripts.push, /^pnpm run check-schema:before-push && /);
  assert.match(packageJson.scripts["check-schema:before-push"], /--before-push$/);
  assert.equal(
    packageJson.scripts["push-force"],
    "bash ./scripts/push-schema-isolated.sh",
  );
  assert.match(
    isolatedScript,
    /NOVALUTH_ISOLATED_SCHEMA_CHECK=1 pnpm run push-force/,
  );
});

test("keeps every installed Drizzle Kit command explicitly classified", async () => {
  const repositoryRoot = new URL("../../..", import.meta.url);
  const { stdout } = await execFileAsync(
    "bash",
    ["scripts/check-schema-wiring.sh"],
    { cwd: repositoryRoot },
  );

  assert.match(stdout, /Drizzle Kit command surface is classified/);
});

test("requires review when Drizzle Kit exposes a new command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schema-cli-surface-"));
  const repositoryRoot = new URL("../../..", import.meta.url);
  const installedDrizzleKit = fileURLToPath(
    new URL("../node_modules/.bin/drizzle-kit", import.meta.url),
  );
  const fakeDrizzleKit = join(directory, "drizzle-kit");

  try {
    const { stdout: help } = await execFileAsync(
      installedDrizzleKit,
      ["--help"],
    );
    await writeFile(
      fakeDrizzleKit,
      `#!/usr/bin/env bash\ncat <<'EOF'\n${help.replace("Flags:", "  apply-next\n\nFlags:")}EOF\n`,
      { mode: 0o755 },
    );

    await assert.rejects(
      execFileAsync("bash", ["scripts/check-schema-wiring.sh"], {
        cwd: repositoryRoot,
        env: { ...process.env, DRIZZLE_KIT_BIN: fakeDrizzleKit },
      }),
      (error: unknown) => {
        assert.ok(error && typeof error === "object" && "stderr" in error);
        const stderr = String((error as { stderr: unknown }).stderr);
        assert.match(stderr, /Unclassified Drizzle command: apply-next/);
        assert.match(
          stderr,
          /Review whether each command can apply data or schema changes/,
        );
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects raw Drizzle destructive command families outside approved entry points", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schema-wiring-"));
  const repositoryRoot = new URL("../../..", import.meta.url);
  const forcePush = ["drizzle-kit", "push", "--force"].join(" ");
  const plainPush = ["drizzle-kit", "push"].join(" ");
  const migrate = ["drizzle-kit", "migrate"].join(" ");

  try {
    await mkdir(join(directory, "scripts"), { recursive: true });
    await mkdir(join(directory, "tools"), { recursive: true });
    await mkdir(join(directory, "lib/db/scripts"), { recursive: true });
    await mkdir(join(directory, "lib/db/node_modules/.bin"), {
      recursive: true,
    });
    await writeFile(
      join(directory, "lib/db/node_modules/.bin/drizzle-kit"),
      `#!/usr/bin/env bash
cat <<'EOF'
Available Commands:
  generate
  migrate
  introspect
  push
  studio
  up
  check
  drop
  export

Flags:
  -h, --help
EOF
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(directory, ".replit"),
      [
        'name = "db-schema"',
        'args = "pnpm --filter @workspace/db run check-schema:wiring && pnpm --filter @workspace/db run check-schema:isolated"',
      ].join("\n"),
    );
    await writeFile(
      join(directory, "scripts/post-merge.sh"),
      "pnpm --filter @workspace/db run check-schema:isolated\n",
    );
    await writeFile(
      join(directory, "lib/db/scripts/push-schema-isolated.sh"),
      `exec ${forcePush} --config ./drizzle.config.ts\n`,
    );
    await writeFile(
      join(directory, "tools/unsafe-schema-push.sh"),
      `${forcePush} --config ./lib/db/drizzle.config.ts\n`,
    );
    await writeFile(
      join(directory, "tools/unsafe-schema-push-equals.sh"),
      `${forcePush}=true --config ./lib/db/drizzle.config.ts\n`,
    );
    await writeFile(
      join(directory, "tools/unsafe-schema-push-plain.sh"),
      `${plainPush} --config ./lib/db/drizzle.config.ts\n`,
    );
    await writeFile(
      join(directory, "tools/unsafe-schema-migrate.sh"),
      `${migrate} --config ./lib/db/drizzle.config.ts\n`,
    );

    await assert.rejects(
      execFileAsync("bash", ["scripts/check-schema-wiring.sh", directory], {
        cwd: repositoryRoot,
      }),
      (error: unknown) => {
        assert.ok(error && typeof error === "object" && "stderr" in error);
        assert.match(
          String((error as { stderr: unknown }).stderr),
          /Unauthorized invocation: tools\/unsafe-schema-push\.sh:1:/,
        );
        assert.match(
          String((error as { stderr: unknown }).stderr),
          /Unauthorized invocation: tools\/unsafe-schema-push-equals\.sh:1:/,
        );
        assert.match(
          String((error as { stderr: unknown }).stderr),
          /Unauthorized invocation: tools\/unsafe-schema-push-plain\.sh:1:/,
        );
        assert.match(
          String((error as { stderr: unknown }).stderr),
          /Unauthorized invocation: tools\/unsafe-schema-migrate\.sh:1:/,
        );
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a direct developer invocation of the force push primitive", async () => {
  const environment = { ...process.env };
  delete environment.NOVALUTH_ISOLATED_SCHEMA_CHECK;

  await assert.rejects(
    execFileAsync("pnpm", ["run", "push-force"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...environment,
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://schema_check@127.0.0.1:5432/postgres",
      },
    }),
    (error: unknown) => {
      assert.ok(error && typeof error === "object" && "stderr" in error);
      assert.match(
        String((error as { stderr: unknown }).stderr),
        /Refusing unreviewed schema force push/,
      );
      return true;
    },
  );
});

test("refuses the isolated marker when the database is not the disposable local cluster", async () => {
  await assert.rejects(
    execFileAsync("pnpm", ["run", "push-force"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: "test",
        NOVALUTH_ISOLATED_SCHEMA_CHECK: "1",
        DATABASE_URL: "postgresql://schema_check@database.example/postgres",
      },
    }),
    (error: unknown) => {
      assert.ok(error && typeof error === "object" && "stderr" in error);
      assert.match(
        String((error as { stderr: unknown }).stderr),
        /outside the isolated PostgreSQL validation database/,
      );
      return true;
    },
  );
});

test("blocks the pre-push entry point when orphan review is missing or incomplete", async () => {
  const query: Sn13SchemaQuery = async () => ({
    rows: [{ table_name: "legacy_table", row_count: "3" }],
  });

  await runWithDevelopmentEnvironment(async () => {
    delete process.env.SCHEMA_ORPHAN_REVIEW_FILE;
    await assert.rejects(
      runSchemaCheck(["--before-push"], query),
      /SCHEMA_ORPHAN_REVIEW_FILE/,
    );

    const directory = await mkdtemp(join(tmpdir(), "schema-review-"));
    const reviewFile = join(directory, "review.json");
    try {
      await writeFile(
        reviewFile,
        JSON.stringify({
          reviewedAt: "2026-09-04T10:00:00.000Z",
          reviewer: "schema-owner",
          decisions: [],
        }),
      );
      process.env.SCHEMA_ORPHAN_REVIEW_FILE = reviewFile;
      await assert.rejects(
        runSchemaCheck(["--before-push"], query),
        /ne couvre pas toutes les tables/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("allows the pre-push entry point after every orphan has a reviewed decision", async () => {
  const query: Sn13SchemaQuery = async () => ({
    rows: [{ table_name: "legacy_table", row_count: "3" }],
  });
  const directory = await mkdtemp(join(tmpdir(), "schema-review-"));
  const reviewFile = join(directory, "review.json");

  try {
    await writeFile(
      reviewFile,
      JSON.stringify({
        reviewedAt: "2026-09-04T10:00:00.000Z",
        reviewer: "schema-owner",
        decisions: [
          {
            tableName: "legacy_table",
            action: "drop",
            reason: "Retention review completed.",
          },
        ],
      }),
    );
    process.env.SCHEMA_ORPHAN_REVIEW_FILE = reviewFile;

    const output = await runWithDevelopmentEnvironment(() =>
      runSchemaCheck(["--before-push"], query),
    );
    assert.match(output, /Revue des tables orphelines validée/);
    assert.match(output, /Le push peut présenter les changements/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
