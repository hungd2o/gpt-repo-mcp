import { describe, expect, test } from "vitest";
import { RepoReaderError } from "../src/runtime/errors.js";
import { createErrorEnvelope, createImageSuccessEnvelope, createSuccessEnvelope } from "../src/runtime/result-envelope.js";

describe("result envelope", () => {
  test("wraps successful structured content", () => {
    const result = createSuccessEnvelope({ repos: [] }, "No approved repositories configured.");

    expect(result.structuredContent).toEqual({ repos: [] });
    expect(result.content[0]?.text).toBe("No approved repositories configured.");
    expect(result.isError).toBeUndefined();
  });

  test("uses the MCP ImageContent shape without adding metadata to the image block", () => {
    const data = Buffer.from("complete image", "utf8").toString("base64");
    const result = createImageSuccessEnvelope(
      { transparency_mode: "preserved" },
      "Returned one image.",
      { data, mimeType: "image/webp" },
      1024
    );

    expect(result.content).toEqual([
      { type: "text", text: "Returned one image." },
      { type: "image", data, mimeType: "image/webp" }
    ]);
    expect(result.content[1]).not.toHaveProperty("transparency_mode");
  });

  test("redacts sensitive and absolute-path details from errors", () => {
    const result = createErrorEnvelope({
      code: "INTERNAL_ERROR",
      message: "Failed reading /Users/example/repo/.env with token sk-secret",
      retryable: false
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.message).not.toContain("/Users/example");
    expect(result.structuredContent.error.message).not.toContain("sk-secret");
  });

  test("exposes only safe allowlisted diagnostics in errors", () => {
    const result = createErrorEnvelope(new RepoReaderError("WRITE_FIND_NOT_FOUND", "find text was not found in src/c.ts.", {
      diagnostics: {
        applied_paths: ["src/a.ts", "/Users/example/repo/src/absolute.ts"],
        failed_path: "src/c.ts",
        recovery_hint: "Run repo_git_review, then use repo_git_restore_paths for tracked applied paths or repo_cleanup_paths for generated untracked artifacts.",
        content: "OPENAI_API_KEY=sk-secret",
        diff: "@@ secret",
        stack: "Error at /Users/example/repo/src/c.ts",
        raw_output: "token sk-secret"
      }
    }));

    expect(result.structuredContent.error.diagnostics).toEqual({
      applied_paths: ["src/a.ts"],
      failed_path: "src/c.ts",
      recovery_hint: "Run repo_git_review, then use repo_git_restore_paths for tracked applied paths or repo_cleanup_paths for generated untracked artifacts."
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("/Users/example");
    expect(serialized).not.toContain("@@ secret");
  });
});
