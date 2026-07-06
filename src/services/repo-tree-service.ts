import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { IgnoreEngine, loadRepoMcpIgnorePatterns } from "./ignore-engine.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";

export type TreeOptions = {
  path?: string;
  max_depth?: number;
  page_size?: number;
  include_files?: boolean;
  respect_default_excludes?: boolean;
  include_generated?: boolean;
  include_dependencies?: boolean;
  cursor?: string;
};

type WarningEntry = { path: string; code: string; message: string };

type SafeReaddirResult =
  | { ok: true; entries: Dirent[] }
  | { ok: false; skipped: { path: string; reason: string } };

async function safeReadDir(absPath: string, relPath: string): Promise<SafeReaddirResult> {
  try {
    return { ok: true, entries: await readdir(absPath, { withFileTypes: true }) };
  } catch (err: unknown) {
    if (isSkippableFsError(err)) {
      return {
        ok: false,
        skipped: {
          path: relPath,
          reason: (typeof err === "object" && err !== null && "code" in err ? (err as { code?: string }).code : undefined) ?? "UNKNOWN_FS_ERROR"
        }
      };
    }
    throw err;
  }
}

function isSkippableFsError(err: unknown): boolean {
  const code = typeof err === "object" && err !== null && "code" in err
    ? (err as { code?: unknown }).code
    : undefined;
  return ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ELOOP", "EBUSY"].includes(code as string);
}

export class RepoTreeService {
  constructor(private readonly root: string, private readonly sandbox: PathSandbox) {}

  async tree(options: TreeOptions) {
    const start = validateRepoPath(options.path ?? ".");
    const maxDepth = Math.min(options.max_depth ?? DEFAULT_LIMITS.max_depth, DEFAULT_LIMITS.max_depth);
    const pageSize = Math.min(options.page_size ?? DEFAULT_LIMITS.max_tree_entries, DEFAULT_LIMITS.max_tree_entries);
    const cursor = parseCursor(options.cursor);
    const includeFiles = options.include_files ?? true;
    const respectDefaultExcludes = options.respect_default_excludes ?? true;
    const entries: Array<{ path: string; type: "file" | "directory" | "nested_repo" | "submodule"; size_bytes?: number }> = [];
    const excludedSummary: Record<string, number> = {};
    const warnings: WarningEntry[] = [];

    const repoPatterns = await loadRepoMcpIgnorePatterns(this.root);
    const ignoreEngine = new IgnoreEngine(repoPatterns);

    const walk = async (repoPath: string, depth: number): Promise<void> => {
      if (depth > maxDepth) {
        return;
      }

      const resolved = await this.resolveForTree(repoPath, excludedSummary, warnings);
      if (!resolved) {
        return;
      }
      const boundary = await this.sandbox.classifyBoundary(repoPath);
      if (boundary.kind !== "normal" && repoPath !== ".") {
        entries.push({ path: boundary.path, type: boundary.kind });
        return;
      }
      if (resolved.stat.isDirectory()) {
        if (repoPath !== ".") {
          entries.push({ path: repoPath, type: "directory" });
        }
        const read = await safeReadDir(resolved.absolutePath, repoPath);
        if (!read.ok) {
          warnings.push({ path: read.skipped.path, code: read.skipped.reason, message: "Skipped inaccessible directory" });
          excludedSummary.inaccessible = (excludedSummary.inaccessible ?? 0) + 1;
          return;
        }
        for (const child of read.entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const childRepoPath = repoPath === "." ? child.name : `${repoPath}/${child.name}`;
          if (ignoreEngine.isSensitiveCandidate(childRepoPath)) {
            excludedSummary.secret_candidates = (excludedSummary.secret_candidates ?? 0) + 1;
            continue;
          }
          const isDependency = isDependencyPath(childRepoPath);
          const isGenerated = isGeneratedPath(childRepoPath);
          if (isDependency && !options.include_dependencies) {
            excludedSummary.dependencies = (excludedSummary.dependencies ?? 0) + 1;
            excludedSummary.default_excludes = (excludedSummary.default_excludes ?? 0) + 1;
            continue;
          }
          if (isGenerated && !options.include_generated) {
            excludedSummary.generated = (excludedSummary.generated ?? 0) + 1;
            excludedSummary.default_excludes = (excludedSummary.default_excludes ?? 0) + 1;
            continue;
          }
          const includedByFlag = (isDependency && options.include_dependencies) || (isGenerated && options.include_generated);
          if (respectDefaultExcludes && !includedByFlag) {
            // Check the plain path OR, for directories, a sentinel child path so that
            // patterns like "artifacts/**" or "**/.venv/**" prune the directory entry itself.
            const dirPruned = child.isDirectory() && ignoreEngine.isIgnored(`${childRepoPath}/__prune__`);
            if (ignoreEngine.isIgnored(childRepoPath) || dirPruned) {
              excludedSummary.default_excludes = (excludedSummary.default_excludes ?? 0) + 1;
              continue;
            }
          }
          await walk(childRepoPath, depth + 1);
        }
        return;
      }
      if (includeFiles && resolved.stat.isFile()) {
        entries.push({ path: repoPath, type: "file", size_bytes: Number(resolved.stat.size) });
      }
    };

    await walk(start, 0);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const pagedEntries = entries.slice(cursor, cursor + pageSize);
    const nextIndex = cursor + pagedEntries.length;
    const truncated = nextIndex < entries.length;
    return {
      entries: pagedEntries,
      warnings,
      excluded_summary: excludedSummary,
      truncated,
      next_cursor: truncated ? String(nextIndex) : undefined
    };
  }

  private async resolveForTree(
    repoPath: string,
    excludedSummary: Record<string, number>,
    warnings: WarningEntry[]
  ): Promise<Awaited<ReturnType<PathSandbox["resolve"]>> | undefined> {
    try {
      return await this.sandbox.resolve(repoPath);
    } catch (error) {
      if (error instanceof RepoReaderError) {
        excludedSummary[error.code] = (excludedSummary[error.code] ?? 0) + 1;
        return undefined;
      }
      if (isSkippableFsError(error)) {
        const code = (typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined) ?? "UNKNOWN_FS_ERROR";
        warnings.push({ path: repoPath, code, message: "Skipped inaccessible path" });
        excludedSummary.inaccessible = (excludedSummary.inaccessible ?? 0) + 1;
        return undefined;
      }
      throw error;
    }
  }
}

function parseCursor(cursor?: string): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isGeneratedPath(repoPath: string): boolean {
  return /(^|\/)(dist|build|out|coverage)(\/|$)/.test(repoPath);
}

function isDependencyPath(repoPath: string): boolean {
  return /(^|\/)node_modules(\/|$)/.test(repoPath);
}
