import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { IgnoreEngine, loadRepoMcpIgnorePatterns } from "./ignore-engine.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";

const MAX_WARNINGS = 100;

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

function pushWarning(warnings: WarningEntry[], entry: WarningEntry, overflowCount: { value: number }): void {
  if (warnings.length < MAX_WARNINGS) {
    warnings.push(entry);
  } else {
    overflowCount.value += 1;
  }
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
    const warningOverflow = { value: 0 };

    const repoPatterns = await loadRepoMcpIgnorePatterns(this.root);
    const ignoreEngine = new IgnoreEngine(repoPatterns);

    const isVisibleBoundaryChild = (child: Dirent, childRepoPath: string): boolean => {
      if (ignoreEngine.isSensitiveCandidate(childRepoPath)) {
        return false;
      }
      const isDependency = isDependencyPath(childRepoPath);
      const isGenerated = isGeneratedPath(childRepoPath);
      if (isDependency && !options.include_dependencies) {
        return false;
      }
      if (isGenerated && !options.include_generated) {
        return false;
      }
      const includedByFlag = (isDependency && options.include_dependencies) || (isGenerated && options.include_generated);
      if (respectDefaultExcludes && !includedByFlag && ignoreEngine.isIgnored(childRepoPath)) {
        return false;
      }
      if (child.isFile() && !includeFiles) {
        return false;
      }
      return true;
    };

    const walk = async (repoPath: string, depth: number, dirent?: Dirent): Promise<void> => {
      if (depth > maxDepth) {
        return;
      }

      // Determine entry type from Dirent when available to avoid redundant lstat calls.
      // For symlinks or the initial root entry (no dirent), fall back to the full resolve path.
      const isDir = dirent ? dirent.isDirectory() : undefined;
      const isFile = dirent ? dirent.isFile() : undefined;
      const isSymlink = dirent ? dirent.isSymbolicLink() : true; // assume symlink if unknown

      // Symlinks and the root entry need full resolve for sandbox escape detection.
      if (isSymlink || (!isDir && !isFile)) {
        const resolved = await this.resolveForTree(repoPath, excludedSummary, warnings, warningOverflow);
        if (!resolved) {
          return;
        }
        const boundary = await this.sandbox.classifyBoundary(repoPath);
        if (boundary.kind !== "normal" && repoPath !== ".") {
          entries.push({ path: boundary.path, type: boundary.kind });
          return;
        }
        if (resolved.stat.isDirectory()) {
          await walkDirectory(repoPath, depth, resolved.absolutePath);
        } else if (includeFiles && resolved.stat.isFile()) {
          entries.push({ path: repoPath, type: "file", size_bytes: Number(resolved.stat.size) });
        }
        return;
      }

      if (isDir) {
        const boundary = await this.sandbox.classifyBoundary(repoPath);
        if (boundary.kind !== "normal" && repoPath !== ".") {
          entries.push({ path: boundary.path, type: boundary.kind });
          return;
        }
        const absPath = join(this.root, repoPath);
        await walkDirectory(repoPath, depth, absPath);
      } else if (isFile && includeFiles) {
        // We still need lstat for size_bytes on files.
        try {
          const absPath = join(this.root, repoPath);
          const stat = await lstat(absPath);
          entries.push({ path: repoPath, type: "file", size_bytes: Number(stat.size) });
        } catch (err: unknown) {
          if (isSkippableFsError(err)) {
            const code = (typeof err === "object" && err !== null && "code" in err ? (err as { code?: string }).code : undefined) ?? "UNKNOWN_FS_ERROR";
            pushWarning(warnings, { path: repoPath, code, message: "Skipped inaccessible path" }, warningOverflow);
            excludedSummary.inaccessible = (excludedSummary.inaccessible ?? 0) + 1;
            return;
          }
          throw err;
        }
      }
    };

    const walkDirectory = async (repoPath: string, depth: number, absPath: string): Promise<void> => {
      if (depth >= maxDepth && repoPath !== ".") {
        const read = await safeReadDir(absPath, repoPath);
        if (!read.ok) {
          pushWarning(warnings, { path: read.skipped.path, code: read.skipped.reason, message: "Skipped inaccessible directory" }, warningOverflow);
          excludedSummary.inaccessible = (excludedSummary.inaccessible ?? 0) + 1;
          return;
        }
        const hasVisibleBoundaryChild = read.entries.some((child) => {
          const childRepoPath = repoPath === "." ? child.name : `${repoPath}/${child.name}`;
          return isVisibleBoundaryChild(child, childRepoPath);
        });
        if (hasVisibleBoundaryChild) {
          entries.push({ path: repoPath, type: "directory" });
        }
        return;
      }

      const read = await safeReadDir(absPath, repoPath);
      if (!read.ok) {
        pushWarning(warnings, { path: read.skipped.path, code: read.skipped.reason, message: "Skipped inaccessible directory" }, warningOverflow);
        excludedSummary.inaccessible = (excludedSummary.inaccessible ?? 0) + 1;
        return;
      }

      const countBefore = entries.length;

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
        if (respectDefaultExcludes && !includedByFlag && ignoreEngine.isIgnored(childRepoPath)) {
          excludedSummary.default_excludes = (excludedSummary.default_excludes ?? 0) + 1;
          continue;
        }
        await walk(childRepoPath, depth + 1, child);
      }

      // Emit the directory entry only after recursion so that directories whose
      // entire subtree is filtered out (e.g. by "artifacts/**") are omitted.
      // Negation patterns like "!artifacts/keep.txt" are handled correctly because
      // any re-included descendant will have been pushed to entries above,
      // causing entries.length > countBefore and the directory to be emitted.
      if (repoPath !== "." && entries.length > countBefore) {
        entries.push({ path: repoPath, type: "directory" });
      }
    };

    await walk(start, 0);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const pagedEntries = entries.slice(cursor, cursor + pageSize);
    const nextIndex = cursor + pagedEntries.length;
    const truncated = nextIndex < entries.length;

    if (warningOverflow.value > 0) {
      warnings.push({ path: "", code: "TRUNCATED", message: `[truncated] ${warningOverflow.value} more warnings omitted` });
    }

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
    warnings: WarningEntry[],
    warningOverflow: { value: number }
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
        pushWarning(warnings, { path: repoPath, code, message: "Skipped inaccessible path" }, warningOverflow);
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
