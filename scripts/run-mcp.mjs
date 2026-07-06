import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { maybePromptRuntimeMenu } from "./runtime-menu.mjs";

const CONFIG_PATH = "./config.local.json";
const PORT = "8787";
const TASK_NAME = "gpt-repo-mcp";

await loadDotEnv(".env");
await ensureConfigExists();

const child = spawn("npm", ["run", "dev"], {
  shell: process.platform === "win32",
  env: {
    ...process.env,
    GPT_REPO_CONFIG: process.env.GPT_REPO_CONFIG || CONFIG_PATH,
    REPO_READER_CONFIG: process.env.REPO_READER_CONFIG || CONFIG_PATH,
    PORT: process.env.PORT || PORT
  },
  stdio: ["inherit", "pipe", "pipe"]
});

let askedInteractiveOptions = false;
let handoffToBackground = false;

mirrorAndDetectReady(child.stdout, process.stdout);
mirrorAndDetectReady(child.stderr, process.stderr);

child.once("error", (error) => {
  globalThis.console.error(`Failed to start MCP server: ${error.message}`);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  if (handoffToBackground) {
    process.exit(0);
  }
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  if (!child.killed) {
    child.kill("SIGINT");
  }
});

process.on("SIGTERM", () => {
  if (!child.killed) {
    child.kill("SIGTERM");
  }
});

function mirrorAndDetectReady(stream, destination) {
  let buffer = "";
  stream.on("data", (chunk) => {
    const text = chunk.toString();
    destination.write(text);
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!askedInteractiveOptions && /gpt-repo-mcp listening on http:\/\/localhost:\d+/.test(line)) {
        askedInteractiveOptions = true;
        void maybeOfferRuntimeOptions();
      }
    }
  });
}

async function maybeOfferRuntimeOptions() {
  const action = await maybePromptRuntimeMenu({
    appLabel: "MCP",
    allowServiceInstall: process.platform === "win32",
    installService: installStartupService,
    runServiceNow: runStartupServiceNow
  });
  if (action === "background" || action === "service-background" || action === "exit") {
    handoffToBackground = true;
    child.kill("SIGTERM");
  }
}

function installStartupService() {
  const result = runSchtasks([
    "/Create",
    "/SC",
    "ONLOGON",
    "/TN",
    TASK_NAME,
    "/TR",
    startupCommand(),
    "/F"
  ]);
  if (result.status === 0) {
    return { ok: true, message: "Installed startup service gpt-repo-mcp." };
  }
  return { ok: false, message: result.stderr || result.stdout || "Failed to install startup service." };
}

function runStartupServiceNow() {
  const result = runSchtasks(["/Run", "/TN", TASK_NAME]);
  if (result.status === 0) {
    return { ok: true, message: "Started startup service in background." };
  }
  return { ok: false, message: result.stderr || result.stdout || "Failed to start startup service." };
}

function startupCommand() {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${backgroundLauncherPath()}"`;
}

function backgroundLauncherPath() {
  return resolve(process.cwd(), "scripts", "start-mcp-background.ps1");
}

function runSchtasks(args) {
  const result = spawnSync("schtasks", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout?.trim(),
    stderr: result.stderr?.trim()
  };
}

async function loadDotEnv(path) {
  try {
    const raw = await readFile(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }
      const eqIdx = trimmed.indexOf("=");
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional
  }
}

async function ensureConfigExists() {
  try {
    await access(CONFIG_PATH, constants.F_OK);
  } catch {
    globalThis.console.error("Missing config.local.json. Run: npm run setup:config");
    process.exit(1);
  }
}
