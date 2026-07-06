import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Resolves the real path of a file or directory, falling back to `path.resolve()`
 * when `realpath` fails with a permission error (EPERM / EACCES).
 *
 * On Windows, `realpath` can throw EPERM for paths with reparse points,
 * junctions, or other entries that require elevated privileges to dereference.
 * In that case the OS itself prevents symlink traversal, so using the
 * non-symlink-resolved absolute path is an acceptable and safe fallback.
 */
export async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isPermissionError(error)) {
      return resolve(path);
    }
    throw error;
  }
}

function isPermissionError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && ((error as { code?: unknown }).code === "EPERM"
      || (error as { code?: unknown }).code === "EACCES")
  );
}
