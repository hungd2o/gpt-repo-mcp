import ignore from "ignore";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { posix } from "node:path";
import { DEFAULT_EXCLUDES } from "../policies/default-excludes.js";

const PUBLIC_ENV_TEMPLATE_PATHS = new Set([".env.example", ".env.sample", ".env.template", "example.env"]);

export class IgnoreEngine {
  private readonly matcher = ignore().add([...DEFAULT_EXCLUDES]);

  constructor(extraPatterns: readonly string[] = []) {
    if (extraPatterns.length > 0) {
      this.matcher.add([...extraPatterns]);
    }
  }

  isIgnored(repoPath: string): boolean {
    const normalized = normalizeRepoPath(repoPath);
    return this.matcher.ignores(normalized);
  }

  isSensitiveCandidate(repoPath: string): boolean {
    const normalized = normalizeRepoPath(repoPath);
    if (isPublicEnvTemplatePath(normalized)) {
      return false;
    }
    const lower = normalized.toLowerCase();
    const base = posix.basename(lower);
    const segments = lower.split("/");

    return (
      base === ".env" ||
      base.startsWith(".env.") ||
      base.endsWith(".pem") ||
      base.endsWith(".key") ||
      base.endsWith(".p12") ||
      base.endsWith(".pfx") ||
      base === "id_rsa" ||
      base === "id_ed25519" ||
      segments.includes("secrets") ||
      segments.includes("credentials")
    );
  }
}

export function normalizeRepoPath(repoPath: string): string {
  return repoPath.replaceAll("\\", "/").replace(/^\/+/, "");
}

export function isPublicEnvTemplatePath(repoPath: string): boolean {
  return PUBLIC_ENV_TEMPLATE_PATHS.has(normalizeRepoPath(repoPath));
}

/**
 * Reads `.repo-mcpignore` from the given repo root and returns its non-empty,
 * non-comment lines as an array of gitignore-style patterns.
 *
 * If the file does not exist or cannot be read, an empty array is returned
 * so the caller can continue without per-repo excludes.
 */
export async function loadRepoMcpIgnorePatterns(repoRoot: string): Promise<string[]> {
  try {
    const raw = await readFile(join(repoRoot, ".repo-mcpignore"), "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}
