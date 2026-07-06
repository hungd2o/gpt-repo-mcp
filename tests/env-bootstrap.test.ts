import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadEnv } from "../scripts/load-env.mjs";

/**
 * Env bootstrap tests – verifies the precedence rules documented in scripts/load-env.mjs:
 *
 *   1. Shell / cross-env (pre-existing process.env) wins over all files.
 *   2. .env.dev overrides .env in dev mode.
 *   3. .env is always loaded as the base.
 *   4. Behavior is identical whether called from connect or connect secure paths.
 */

// ---------------------------------------------------------------------------
// Keys touched by the tests – cleaned up before and after each test
// ---------------------------------------------------------------------------
const TEST_KEYS = [
  "GPT_REPO_ACCESS_TOKEN",
  "GPT_REPO_PUBLIC_PATH_TOKEN",
  "GPT_REPO_CONFIG",
  "GPT_REPO_LOG_FORMAT",
  "PORT",
  "SOME_ABSENT_KEY"
];

let tmpDir: string;
let savedEnv: Partial<Record<string, string>>;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "gpt-repo-env-test-"));
  // Save existing values for the keys we might touch
  savedEnv = Object.fromEntries(TEST_KEYS.map((k) => [k, process.env[k]]));
  // Start each test from a clean slate for these keys
  for (const key of TEST_KEYS) {
    delete process.env[key];
  }
});

afterEach(async () => {
  // Restore original values
  for (const key of TEST_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeEnvFile(filename: string, content: string): Promise<void> {
  await writeFile(join(tmpDir, filename), content, "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("env bootstrap (load-env.mjs)", () => {
  test(".env is loaded by default (no dev flag)", async () => {
    await writeEnvFile(".env", "GPT_REPO_ACCESS_TOKEN=from-dotenv\nPORT=9999\n");

    await loadEnv({ cwd: tmpDir });

    expect(process.env["GPT_REPO_ACCESS_TOKEN"]).toBe("from-dotenv");
    expect(process.env["PORT"]).toBe("9999");
  });

  test("keys absent from .env are not set", async () => {
    await writeEnvFile(".env", "GPT_REPO_ACCESS_TOKEN=token-abc\n");

    await loadEnv({ cwd: tmpDir });

    expect(process.env["GPT_REPO_ACCESS_TOKEN"]).toBe("token-abc");
    expect(process.env["SOME_ABSENT_KEY"]).toBeUndefined();
  });

  test("missing .env is silently ignored", async () => {
    // No file written – loadEnv must not throw
    await expect(loadEnv({ cwd: tmpDir })).resolves.toBeUndefined();
    expect(process.env["GPT_REPO_ACCESS_TOKEN"]).toBeUndefined();
  });

  test("pre-existing process.env wins over .env (simulates cross-env GPT_REPO_CONFIG=...)", async () => {
    process.env["GPT_REPO_CONFIG"] = "./custom-config.json";
    await writeEnvFile(".env", "GPT_REPO_CONFIG=./config.local.json\n");

    await loadEnv({ cwd: tmpDir });

    // Shell / cross-env value must survive
    expect(process.env["GPT_REPO_CONFIG"]).toBe("./custom-config.json");
  });

  test("pre-existing process.env wins over GPT_REPO_ACCESS_TOKEN from .env", async () => {
    process.env["GPT_REPO_ACCESS_TOKEN"] = "shell-token";
    await writeEnvFile(".env", "GPT_REPO_ACCESS_TOKEN=file-token\n");

    await loadEnv({ cwd: tmpDir });

    expect(process.env["GPT_REPO_ACCESS_TOKEN"]).toBe("shell-token");
  });

  test(".env.dev overrides .env in dev mode", async () => {
    await writeEnvFile(".env", "GPT_REPO_LOG_FORMAT=pretty\nGPT_REPO_ACCESS_TOKEN=base-token\n");
    await writeEnvFile(".env.dev", "GPT_REPO_LOG_FORMAT=json\n");

    await loadEnv({ dev: true, cwd: tmpDir });

    // .env.dev overrides .env for GPT_REPO_LOG_FORMAT
    expect(process.env["GPT_REPO_LOG_FORMAT"]).toBe("json");
    // Keys not in .env.dev remain from .env
    expect(process.env["GPT_REPO_ACCESS_TOKEN"]).toBe("base-token");
  });

  test(".env.dev is ignored when dev=false", async () => {
    await writeEnvFile(".env", "GPT_REPO_LOG_FORMAT=pretty\n");
    await writeEnvFile(".env.dev", "GPT_REPO_LOG_FORMAT=json\n");

    await loadEnv({ dev: false, cwd: tmpDir });

    // .env.dev must not be read
    expect(process.env["GPT_REPO_LOG_FORMAT"]).toBe("pretty");
  });

  test("missing .env.dev is silently ignored in dev mode", async () => {
    await writeEnvFile(".env", "GPT_REPO_ACCESS_TOKEN=only-base\n");
    // .env.dev intentionally absent

    await expect(loadEnv({ dev: true, cwd: tmpDir })).resolves.toBeUndefined();
    expect(process.env["GPT_REPO_ACCESS_TOKEN"]).toBe("only-base");
  });

  test("pre-existing process.env wins over .env.dev in dev mode", async () => {
    process.env["GPT_REPO_LOG_FORMAT"] = "shell-format";
    await writeEnvFile(".env", "GPT_REPO_LOG_FORMAT=pretty\n");
    await writeEnvFile(".env.dev", "GPT_REPO_LOG_FORMAT=json\n");

    await loadEnv({ dev: true, cwd: tmpDir });

    // Shell wins over both files
    expect(process.env["GPT_REPO_LOG_FORMAT"]).toBe("shell-format");
  });

  test("quoted values in .env are unquoted correctly", async () => {
    await writeEnvFile(
      ".env",
      'GPT_REPO_ACCESS_TOKEN="double-quoted-token"\nGPT_REPO_CONFIG=\'single-quoted-config\'\n'
    );

    await loadEnv({ cwd: tmpDir });

    expect(process.env["GPT_REPO_ACCESS_TOKEN"]).toBe("double-quoted-token");
    expect(process.env["GPT_REPO_CONFIG"]).toBe("single-quoted-config");
  });

  test("commented and blank lines in .env are ignored", async () => {
    await writeEnvFile(
      ".env",
      ["# This is a comment", "", "GPT_REPO_ACCESS_TOKEN=valid-token", "# PORT=commented-out", ""].join("\n")
    );

    await loadEnv({ cwd: tmpDir });

    expect(process.env["GPT_REPO_ACCESS_TOKEN"]).toBe("valid-token");
    expect(process.env["PORT"]).toBeUndefined();
  });

  test("connect and connect:secure flows both reference the shared load-env.mjs module", async () => {
    const connectDev = await readFile(resolve(process.cwd(), "scripts", "connect-dev.mjs"), "utf8");
    const connectSecure = await readFile(resolve(process.cwd(), "scripts", "connect-secure.mjs"), "utf8");

    // Both scripts must import from the shared module
    expect(connectDev).toContain("load-env.mjs");
    expect(connectDev).toContain("loadEnv");
    expect(connectSecure).toContain("load-env.mjs");
    expect(connectSecure).toContain("loadEnv");

    // Neither script should define its own loadDotEnv any more
    expect(connectDev).not.toContain("function loadDotEnv");
    expect(connectSecure).not.toContain("function loadDotEnv");
  });
});

