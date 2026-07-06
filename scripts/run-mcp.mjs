import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

const CONFIG_PATH = "./config.local.json";
const PORT = "8787";
const TASK_NAME = "gpt-repo-mcp";

await loadDotEnv(".env");
await ensureConfigExists();

const child = spawn("npm", ["run", "dev"], {
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
        void maybeOfferWindowsRuntimeOptions();
      }
    }
  });
}

async function maybeOfferWindowsRuntimeOptions() {
  if (process.platform !== "win32" || !process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("\nMCP started. Choose next step:\n");
    process.stdout.write("  [1] Keep running in this terminal\n");
    process.stdout.write("  [2] Move this MCP run to background now\n");
    process.stdout.write("  [3] Install startup service (Task Scheduler)\n");
    const answer = (await rl.question("Select 1/2/3 (default 1): ")).trim();
    if (answer === "2") {
      if (!startBackgroundNow()) {
        process.stderr.write("Could not start background MCP process.\n");
        return;
      }
      process.stdout.write("MCP moved to background. Closing this terminal session.\n");
      handoffToBackground = true;
      child.kill("SIGTERM");
      return;
    }
    if (answer === "3") {
      const installed = installStartupService();
      if (!installed.ok) {
        process.stderr.write(`${installed.message}\n`);
        return;
      }
      process.stdout.write(`${installed.message}\n`);
      const runNow = (await rl.question("Start service now and close this terminal? [y/N]: ")).trim();
      if (/^y(es)?$/i.test(runNow)) {
        const started = runStartupServiceNow();
        if (!started.ok) {
          process.stderr.write(`${started.message}\n`);
          return;
        }
        process.stdout.write(`${started.message}\n`);
        handoffToBackground = true;
        child.kill("SIGTERM");
      }
    }
  } finally {
    rl.close();
  }
}

function startBackgroundNow() {
  try {
    const result = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      backgroundLauncherPath()
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    result.unref();
    return true;
  } catch {
    return false;
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
