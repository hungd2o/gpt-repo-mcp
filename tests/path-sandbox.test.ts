import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { safeRealpath } from "../src/services/fs-utils.js";

describe("PathSandbox", () => {
  test("rejects absolute model-supplied paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    const sandbox = new PathSandbox(root);

    await expect(sandbox.resolve("/etc/passwd")).rejects.toMatchObject({
      code: "ABSOLUTE_PATH_REJECTED"
    });
  });

  test("rejects path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    const sandbox = new PathSandbox(root);

    await expect(sandbox.resolve("../outside.txt")).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_REJECTED"
    });
  });

  test("rejects symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    const outside = await mkdtemp(join(tmpdir(), "repo-reader-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "linked-secret.txt"));

    const sandbox = new PathSandbox(root);

    await expect(sandbox.resolve("linked-secret.txt")).rejects.toMatchObject({
      code: "SYMLINK_ESCAPE_REJECTED"
    });
  });

  test("detects nested repositories without treating them as normal files", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    await mkdir(join(root, "vendor", "lib", ".git"), { recursive: true });

    const sandbox = new PathSandbox(root);
    const result = await sandbox.classifyBoundary("vendor/lib");

    expect(result).toEqual({ kind: "nested_repo", path: "vendor/lib" });
  });
});

describe("safeRealpath", () => {
  test("returns the real path for an existing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    const result = await safeRealpath(root);
    expect(result).toBe(resolve(root));
  });

  test("re-throws non-permission errors such as ENOENT", async () => {
    await expect(safeRealpath(join(tmpdir(), "does-not-exist-xyzzy"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
