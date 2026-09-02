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
    assert.doesNotMatch(
      output,
      /Failed to stop the isolated PostgreSQL server/,
      "normal PostgreSQL cleanup emitted a shutdown failure",
    );
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

test("reports missing PostgreSQL tools and removes its temporary directory", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "novaluth-schema-check-missing-tools-test-"),
  );
  const pathWithoutPostgresTools = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => {
      if (entry.length === 0) {
        return false;
      }

      return ["initdb", "pg_ctl"].every((tool) => {
        try {
          fs.accessSync(path.join(entry, tool), fs.constants.X_OK);
          return false;
        } catch {
          return true;
        }
      });
    })
    .concat(path.dirname(process.execPath))
    .join(path.delimiter);
  const environment = {
    ...process.env,
    DATABASE_URL: "postgresql://development.invalid/novaluth",
    NODE_ENV: "development",
    PATH: pathWithoutPostgresTools,
    TMPDIR: temporaryRoot,
  };

  try {
    assert.equal(
      execFileSync(
        "bash",
        ["-c", "command -v initdb || true; command -v pg_ctl || true"],
        { env: environment, encoding: "utf8" },
      ),
      "",
      "the controlled PATH unexpectedly contains a PostgreSQL tool",
    );

    let subprocessError: {
      status?: number | null;
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };

    try {
      execFileSync("bash", [isolatedCheckScript], {
        cwd: packageRoot,
        env: environment,
        encoding: "utf8",
      });
      assert.fail("the isolated PostgreSQL check unexpectedly succeeded");
    } catch (error) {
      subprocessError = error as {
        status?: number | null;
        stderr?: string | Buffer;
        stdout?: string | Buffer;
      };
    }

    assert.equal(subprocessError.status, 1);
    const output = [
      subprocessError.stdout ?? "",
      subprocessError.stderr ?? "",
    ].join("\n");
    assert.match(
      output,
      /PostgreSQL client and server tools \(initdb and pg_ctl\) are required\./,
    );
    assert.deepEqual(
      fs
        .readdirSync(temporaryRoot)
        .filter((entry) => entry.startsWith("novaluth-schema-check.")),
      [],
      "the isolated PostgreSQL temporary directory was not removed",
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("reports a PostgreSQL startup failure and removes its temporary directory", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "novaluth-schema-check-startup-test-"),
  );
  const fakeBin = path.join(temporaryRoot, "bin");
  const realPgCtl = execFileSync("bash", ["-c", "command -v pg_ctl"], {
    encoding: "utf8",
  }).trim();
  const fakePgCtl = path.join(fakeBin, "pg_ctl");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    fakePgCtl,
    `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "\${*: -1}" == "start" ]]; then
  for argument in "$@"; do
    if [[ "$argument" == --log=* ]]; then
      printf '%s\n' "simulated PostgreSQL startup failure" > "\${argument#--log=}"
    fi
  done
  exit 47
fi
exec "${realPgCtl}" "$@"
`,
    { mode: 0o755 },
  );

  try {
    let subprocessError: {
      status?: number | null;
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };

    try {
      execFileSync("bash", [isolatedCheckScript], {
        cwd: packageRoot,
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://development.invalid/novaluth",
          NODE_ENV: "development",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TMPDIR: temporaryRoot,
        },
        encoding: "utf8",
      });
      assert.fail("the isolated PostgreSQL startup unexpectedly succeeded");
    } catch (error) {
      subprocessError = error as {
        status?: number | null;
        stderr?: string | Buffer;
        stdout?: string | Buffer;
      };
    }

    assert.equal(subprocessError.status, 47);
    const output = [
      subprocessError.stdout ?? "",
      subprocessError.stderr ?? "",
    ].join("\n");
    assert.match(
      output,
      /Failed to start the isolated PostgreSQL server \(pg_ctl exit status 47\)\./,
    );
    assert.match(output, /simulated PostgreSQL startup failure/);
    assert.deepEqual(
      fs
        .readdirSync(temporaryRoot)
        .filter((entry) => entry.startsWith("novaluth-schema-check.")),
      [],
      "the isolated PostgreSQL temporary directory was not removed",
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("reports an initdb failure and removes its temporary directory", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "novaluth-schema-check-initdb-test-"),
  );
  const fakeBin = path.join(temporaryRoot, "bin");
  const fakeInitdb = path.join(fakeBin, "initdb");
  const initdbInvocationMarker = path.join(temporaryRoot, "initdb-invoked");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    fakeInitdb,
    `#!/usr/bin/env bash
set -Eeuo pipefail
data_dir=""
for argument in "$@"; do
  if [[ "$argument" == --pgdata=* ]]; then
    data_dir="\${argument#--pgdata=}"
  fi
done
mkdir -p "$data_dir"
printf '%s\n' "partial initdb state" > "$data_dir/partial-state"
printf '%s\n' "initdb invoked" > "\${TMPDIR}/initdb-invoked"
echo "simulated PostgreSQL initdb failure" >&2
exit 43
`,
    { mode: 0o755 },
  );

  try {
    let subprocessError: {
      status?: number | null;
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };

    try {
      execFileSync("bash", [isolatedCheckScript], {
        cwd: packageRoot,
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://development.invalid/novaluth",
          NODE_ENV: "development",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TMPDIR: temporaryRoot,
        },
        encoding: "utf8",
      });
      assert.fail("the isolated PostgreSQL initdb unexpectedly succeeded");
    } catch (error) {
      subprocessError = error as {
        status?: number | null;
        stderr?: string | Buffer;
        stdout?: string | Buffer;
      };
    }

    assert.equal(subprocessError.status, 43);
    assert.equal(fs.readFileSync(initdbInvocationMarker, "utf8").trim(), "initdb invoked");
    const output = [
      subprocessError.stdout ?? "",
      subprocessError.stderr ?? "",
    ].join("\n");
    assert.match(
      output,
      /Failed to initialize the isolated PostgreSQL data directory \(initdb exit status 43\)\./,
    );
    assert.match(output, /simulated PostgreSQL initdb failure/);
    assert.deepEqual(
      fs
        .readdirSync(temporaryRoot)
        .filter((entry) => entry.startsWith("novaluth-schema-check.")),
      [],
      "the isolated PostgreSQL temporary directory was not removed",
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("reports a PostgreSQL shutdown failure without masking the requested command status", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "novaluth-schema-check-shutdown-test-"),
  );
  const fakeBin = path.join(temporaryRoot, "bin");
  const realPgCtl = execFileSync("bash", ["-c", "command -v pg_ctl"], {
    encoding: "utf8",
  }).trim();
  const fakePgCtl = path.join(fakeBin, "pg_ctl");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    fakePgCtl,
    `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "\${*: -1}" == "stop" ]]; then
  echo "simulated pg_ctl shutdown failure" >&2
  exit 41
fi
exec "${realPgCtl}" "$@"
`,
    { mode: 0o755 },
  );

  const failingChildScript = `
    const { Client } = require("pg");

    (async () => {
      const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      await client.end();
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
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
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
    assert.match(
      output,
      /Failed to stop the isolated PostgreSQL server \(pg_ctl exit status 41\)\./,
    );
    assert.match(output, /simulated pg_ctl shutdown failure/);
    assert.match(
      output,
      /Attempting bounded ownership-safe PostgreSQL recovery \(fallback\)\./,
    );
    assert.match(
      output,
      /Fallback recovery succeeded: the isolated PostgreSQL server exited after SIGTERM\./,
    );
    assert.deepEqual(
      fs
        .readdirSync(temporaryRoot)
        .filter((entry) => entry.startsWith("novaluth-schema-check.")),
      [],
      "the isolated PostgreSQL temporary directory was not removed",
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("escalates to SIGKILL when an owned PostgreSQL process ignores SIGTERM", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "novaluth-schema-check-sigkill-test-"),
  );
  const fakeBin = path.join(temporaryRoot, "bin");
  const realPgCtl = execFileSync("bash", ["-c", "command -v pg_ctl"], {
    encoding: "utf8",
  }).trim();
  const fakePgCtl = path.join(fakeBin, "pg_ctl");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    fakePgCtl,
    `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "\${*: -1}" == "stop" ]]; then
  "${realPgCtl}" "$@" >/dev/null 2>&1 || true
  nohup bash -c 'trap "" TERM; while :; do read -r -t 1 _ || :; done' postgres "$2" >/dev/null 2>&1 &
  stubborn_pid=$!
  for attempt in {1..20}; do
    [[ -s "/proc/$stubborn_pid/cmdline" ]] && break
    sleep 0.01
  done
  printf '%s\n' "$stubborn_pid" > "\${TMPDIR}/stubborn-pid"
  printf '%s\n' "$stubborn_pid" > "$2/postmaster.pid"
  echo "simulated pg_ctl shutdown failure" >&2
  exit 41
fi
exec "${realPgCtl}" "$@"
`,
    { mode: 0o755 },
  );

  const failingChildScript = `
    const { Client } = require("pg");

    (async () => {
      const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      await client.end();
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
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
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
    assert.match(
      output,
      /Failed to stop the isolated PostgreSQL server \(pg_ctl exit status 41\)\./,
    );
    assert.match(output, /simulated pg_ctl shutdown failure/);
    assert.match(
      output,
      /Fallback recovery escalating to SIGKILL after the bounded SIGTERM wait\./,
    );
    assert.match(
      output,
      /Fallback recovery succeeded: the isolated PostgreSQL server exited after SIGKILL\./,
    );

    const stubbornPid = Number(
      fs.readFileSync(path.join(temporaryRoot, "stubborn-pid"), "utf8").trim(),
    );
    assert.ok(Number.isInteger(stubbornPid) && stubbornPid > 0);
    assert.throws(
      () => process.kill(stubbornPid, 0),
      "the SIGTERM-ignoring PostgreSQL process is still running",
    );
    assert.deepEqual(
      fs
        .readdirSync(temporaryRoot)
        .filter((entry) => entry.startsWith("novaluth-schema-check.")),
      [],
      "the isolated PostgreSQL temporary directory was not removed",
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("does not signal an unowned process after a PostgreSQL shutdown failure", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "novaluth-schema-check-unowned-shutdown-test-"),
  );
  const fakeBin = path.join(temporaryRoot, "bin");
  const realPgCtl = execFileSync("bash", ["-c", "command -v pg_ctl"], {
    encoding: "utf8",
  }).trim();
  const fakePgCtl = path.join(fakeBin, "pg_ctl");
  const unownedPidFile = path.join(temporaryRoot, "unowned-pid");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    fakePgCtl,
    `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "\${*: -1}" == "stop" ]]; then
  "${realPgCtl}" "$@"
  sleep 30 >/dev/null 2>&1 </dev/null &
  unowned_pid=$!
  printf '%s\n' "$unowned_pid" > "\${TMPDIR}/unowned-pid"
  printf '%s\n' "$unowned_pid" > "$2/postmaster.pid"
  echo "simulated pg_ctl shutdown failure" >&2
  exit 41
fi
exec "${realPgCtl}" "$@"
`,
    { mode: 0o755 },
  );

  const failingChildScript = `
    const { Client } = require("pg");

    (async () => {
      const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      await client.end();
      process.exitCode = 23;
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  let unownedPid: number | undefined;
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
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
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
    assert.match(
      output,
      /Failed to stop the isolated PostgreSQL server \(pg_ctl exit status 41\)\./,
    );
    assert.match(
      output,
      /Fallback recovery failed: the isolated PostgreSQL process could not be verified as owned; no signal was sent\./,
    );

    unownedPid = Number(fs.readFileSync(unownedPidFile, "utf8").trim());
    assert.ok(Number.isInteger(unownedPid) && unownedPid > 0);
    assert.doesNotThrow(() => process.kill(unownedPid as number, 0));
  } finally {
    if (unownedPid !== undefined) {
      try {
        process.kill(unownedPid, "SIGKILL");
      } catch {
        // The helper may have exited while the assertion was running.
      }
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
