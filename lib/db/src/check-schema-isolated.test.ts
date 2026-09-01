import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const isolatedCheckScript = path.join(
  packageRoot,
  "scripts",
  "check-schema-isolated.sh",
);

const childScript = `
  const assert = require("node:assert/strict");
  const { Client } = require("pg");

  assert.equal(process.env.NODE_ENV, "test");
  assert.match(
    process.env.DATABASE_URL ?? "",
    /^postgresql:\\/\\/schema_check@127\\.0\\.0\\.1:\\d+\\/postgres$/,
  );

  (async () => {
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      await client.query("SELECT 1");
    } finally {
      await client.end();
    }
    console.log(
      "child-observation:" +
        JSON.stringify({
          databaseUrl: process.env.DATABASE_URL,
          nodeEnv: process.env.NODE_ENV,
        }),
    );
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
`;

test("runs the requested command against the isolated PostgreSQL server", () => {
  const developmentDatabaseUrl = "postgresql://development.invalid/novaluth";
  let output: string;

  try {
    output = execFileSync(
      "bash",
      [isolatedCheckScript, "--", process.execPath, "-e", childScript],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          DATABASE_URL: developmentDatabaseUrl,
          NODE_ENV: "development",
        },
        encoding: "utf8",
      },
    );
  } catch (error) {
    const subprocessError = error as {
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };
    throw new Error(
      [
        "The isolated schema check command failed.",
        `stdout:\n${subprocessError.stdout ?? ""}`,
        `stderr:\n${subprocessError.stderr ?? ""}`,
      ].join("\n"),
      { cause: error },
    );
  }

  const observationLine = output
    .split("\n")
    .find((line) => line.startsWith("child-observation:"));
  assert.ok(
    observationLine,
    "the child command did not report its environment",
  );

  const observation = JSON.parse(
    observationLine.slice("child-observation:".length),
  ) as { databaseUrl: string; nodeEnv: string };
  assert.equal(observation.nodeEnv, "test");
  assert.notEqual(observation.databaseUrl, developmentDatabaseUrl);
  assert.match(
    observation.databaseUrl,
    /^postgresql:\/\/schema_check@127\.0\.0\.1:\d+\/postgres$/,
  );

  assert.throws(() =>
    execFileSync(
      process.execPath,
      [
        "-e",
        `
          const { Client } = require("pg");
          const client = new Client({
            connectionString: process.env.DATABASE_URL,
            connectionTimeoutMillis: 2000,
          });
          client.connect().then(() => client.end().then(() => {
            throw new Error("temporary PostgreSQL server is still running");
          })).catch(() => process.exitCode = 1);
        `,
      ],
      {
        cwd: packageRoot,
        env: { ...process.env, DATABASE_URL: observation.databaseUrl },
        stdio: "pipe",
      },
    ),
  );
});

test("cleans up the isolated PostgreSQL server when the requested command fails", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "novaluth-schema-check-test-"),
  );
  const failingChildScript = `
    const { Client } = require("pg");

    (async () => {
      const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      try {
        await client.query("SELECT 1");
      } finally {
        await client.end();
      }
      console.log("child-database-url:" + process.env.DATABASE_URL);
      process.exitCode = 23;
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  try {
    let subprocessError: {
      status?: number | null;
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };

    try {
      execFileSync(
        "bash",
        [isolatedCheckScript, "--", process.execPath, "-e", failingChildScript],
        {
          cwd: packageRoot,
          env: {
            ...process.env,
            DATABASE_URL: "postgresql://development.invalid/novaluth",
            NODE_ENV: "development",
            TMPDIR: temporaryRoot,
          },
          encoding: "utf8",
        },
      );
      assert.fail("the failing child command unexpectedly succeeded");
    } catch (error) {
      subprocessError = error as {
        status?: number | null;
        stderr?: string | Buffer;
        stdout?: string | Buffer;
      };
    }

    assert.equal(subprocessError.status, 23);
    const output = [
      subprocessError.stdout ?? "",
      subprocessError.stderr ?? "",
    ].join("\n");
    const databaseUrlLine = output
      .split("\n")
      .find((line) => line.startsWith("child-database-url:"));
    assert.ok(databaseUrlLine, "the child command did not report its database");
    const databaseUrl = databaseUrlLine.slice("child-database-url:".length);

    assert.deepEqual(
      fs
        .readdirSync(temporaryRoot)
        .filter((entry) => entry.startsWith("novaluth-schema-check.")),
      [],
      "the isolated PostgreSQL temporary directory was not removed",
    );

    assert.doesNotThrow(
      () =>
        execFileSync(
          process.execPath,
          [
            "-e",
            `
              const { Client } = require("pg");
              const client = new Client({
                connectionString: ${JSON.stringify(databaseUrl)},
                connectionTimeoutMillis: 2000,
              });
              (async () => {
                try {
                  await client.connect();
                  await client.end();
                  process.exitCode = 1;
                } catch {
                  process.exitCode = 0;
                }
              })();
            `,
          ],
          { cwd: packageRoot, stdio: "pipe" },
        ),
      "the temporary PostgreSQL server is still running",
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});