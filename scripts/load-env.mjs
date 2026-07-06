/**
 * Centralized environment bootstrap for local/dev runs.
 *
 * Env precedence (highest to lowest):
 *   1. Shell / cross-env  – values already in process.env at call time are never overwritten.
 *   2. .env.dev           – loaded when dev=true and the file exists; overrides .env values
 *                           that were not pre-existing in the shell.
 *   3. .env               – base env, always loaded when the file exists.
 *
 * Both files are optional. Neither file overwrites a value that was already set by the
 * shell or cross-env before loadEnv() is called. .env.dev can override .env because
 * the "already set" check is made against the original process.env snapshot, not against
 * the values written by .env.
 *
 * Usage:
 *   import { loadEnv } from "./load-env.mjs";
 *   await loadEnv();                              // base .env only
 *   await loadEnv({ dev: true });                 // .env + .env.dev override
 *   await loadEnv({ dev: process.env.NODE_ENV === "development" });
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import process from "node:process";

/**
 * @param {{ dev?: boolean, cwd?: string }} [options]
 *   dev  – when true, also load .env.dev as an override over .env.
 *   cwd  – directory to search for .env / .env.dev (defaults to process.cwd()).
 *          Useful for testing without changing the working directory.
 * @returns {Promise<void>}
 */
export async function loadEnv({ dev = false, cwd } = {}) {
  const base = cwd ?? process.cwd();

  // Snapshot the keys that exist before we read any file.
  // This is the set that shell / cross-env owns – we never overwrite these.
  const preExisting = new Set(Object.keys(process.env));

  await loadFile(join(base, ".env"), preExisting);

  if (dev) {
    await loadFile(join(base, ".env.dev"), preExisting);
  }
}

/**
 * Read one dotenv file and set any key that is not in preExisting.
 * @param {string} path
 * @param {Set<string>} preExisting
 * @returns {Promise<void>}
 */
async function loadFile(path, preExisting) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return; // file is optional – silently skip
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    const val = unquote(trimmed.slice(eqIdx + 1));
    if (key && !preExisting.has(key)) {
      process.env[key] = val;
    }
  }
}

/**
 * Strip surrounding single or double quotes from a dotenv value.
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const t = value.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}
