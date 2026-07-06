import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

const TASK_NAME = "gpt-repo-mcp";

export function isWindows() {
  return process.platform === "win32";
}

export function isBackgroundConfigured() {
  if (!isWindows()) {
    return false;
  }
  const result = runSchtasks(["/Query", "/TN", TASK_NAME]);
  return result.status === 0;
}

export async function maybeOfferWindowsBackgroundInstall() {
  if (!isWindows() || !process.stdin.isTTY || !process.stdout.isTTY || isBackgroundConfigured()) {
    return;
  }

  process.stdout.write("Windows tip: run MCP in the background so you can close this terminal.\n");
  process.stdout.write("Install startup task now? [y/N]: ");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer = "";
  try {
    answer = await rl.question("");
  } finally {
    rl.close();
  }

  if (!/^y(es)?$/i.test(answer.trim())) {
    process.stdout.write("Skipped Windows background setup. You can run `npm run mcp:bg:install` later.\n");
    return;
  }

  const installed = installTask();
  if (!installed.ok) {
    process.stderr.write("Failed to install Windows background startup task.\n");
    if (installed.stderr) {
      process.stderr.write(`${installed.stderr}\n`);
    }
    return;
  }

  process.stdout.write("Installed Windows startup task `gpt-repo-mcp`.\n");
  const started = startTask();
  if (started.ok) {
    process.stdout.write("Started background MCP task.\n");
  } else {
    process.stdout.write("Task installed. Start it any time with `npm run mcp:bg:start`.\n");
  }
}

function launcherPath() {
  return resolve(process.cwd(), "scripts", "start-mcp-background.ps1");
}

function taskCommand() {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcherPath()}"`;
}

function runSchtasks(args) {
  return spawnSync("schtasks", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true
  });
}

function installTask() {
  if (!isWindows()) {
    return { ok: false, stderr: "This command is only supported on Windows." };
  }
  if (isBackgroundConfigured()) {
    return { ok: true, alreadyConfigured: true };
  }
  const result = runSchtasks([
    "/Create",
    "/SC",
    "ONLOGON",
    "/TN",
    TASK_NAME,
    "/TR",
    taskCommand(),
    "/F"
  ]);
  return {
    ok: result.status === 0,
    stderr: result.stderr?.trim() || result.stdout?.trim() || ""
  };
}

function removeTask() {
  if (!isWindows()) {
    return { ok: false, stderr: "This command is only supported on Windows." };
  }
  if (!isBackgroundConfigured()) {
    return { ok: true, notConfigured: true };
  }
  const result = runSchtasks(["/Delete", "/TN", TASK_NAME, "/F"]);
  return {
    ok: result.status === 0,
    stderr: result.stderr?.trim() || result.stdout?.trim() || ""
  };
}

function startTask() {
  if (!isWindows()) {
    return { ok: false, stderr: "This command is only supported on Windows." };
  }
  if (!isBackgroundConfigured()) {
    return { ok: false, stderr: "Task is not installed. Run `npm run mcp:bg:install` first." };
  }
  const result = runSchtasks(["/Run", "/TN", TASK_NAME]);
  return {
    ok: result.status === 0,
    stderr: result.stderr?.trim() || result.stdout?.trim() || ""
  };
}

function stopTask() {
  if (!isWindows()) {
    return { ok: false, stderr: "This command is only supported on Windows." };
  }
  if (!isBackgroundConfigured()) {
    return { ok: true, notRunning: true };
  }
  const result = runSchtasks(["/End", "/TN", TASK_NAME]);
  return {
    ok: result.status === 0,
    stderr: result.stderr?.trim() || result.stdout?.trim() || ""
  };
}

function statusTask() {
  if (!isWindows()) {
    process.stdout.write("Background startup is only available on Windows.\n");
    return 0;
  }
  if (!isBackgroundConfigured()) {
    process.stdout.write("Windows background startup is not installed.\n");
    process.stdout.write("Install with `npm run mcp:bg:install`.\n");
    return 0;
  }
  const query = runSchtasks(["/Query", "/TN", TASK_NAME, "/FO", "LIST"]);
  process.stdout.write("Windows background startup is installed.\n");
  const details = query.stdout
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Status:") || line.startsWith("Last Run Time:"));
  if (details && details.length > 0) {
    for (const line of details) {
      process.stdout.write(`${line}\n`);
    }
  }
  process.stdout.write("Use `npm run mcp:bg:start` to start now and `npm run mcp:bg:stop` to stop.\n");
  return 0;
}

export function runWindowsBackgroundCli(argv) {
  const command = argv[0] ?? "status";
  if (command === "status") {
    return statusTask();
  }
  if (command === "install") {
    const result = installTask();
    if (result.ok && result.alreadyConfigured) {
      process.stdout.write("Windows background startup is already installed.\n");
      return 0;
    }
    if (result.ok) {
      process.stdout.write("Installed Windows background startup task.\n");
      process.stdout.write("Run `npm run mcp:bg:start` to launch now.\n");
      return 0;
    }
    process.stderr.write(`${result.stderr}\n`);
    return 1;
  }
  if (command === "remove") {
    const result = removeTask();
    if (result.ok && result.notConfigured) {
      process.stdout.write("Windows background startup is not installed.\n");
      return 0;
    }
    if (result.ok) {
      process.stdout.write("Removed Windows background startup task.\n");
      return 0;
    }
    process.stderr.write(`${result.stderr}\n`);
    return 1;
  }
  if (command === "start") {
    const result = startTask();
    if (result.ok) {
      process.stdout.write("Started Windows background startup task.\n");
      return 0;
    }
    process.stderr.write(`${result.stderr}\n`);
    return 1;
  }
  if (command === "stop") {
    const result = stopTask();
    if (result.ok && result.notRunning) {
      process.stdout.write("Windows background startup is not installed.\n");
      return 0;
    }
    if (result.ok) {
      process.stdout.write("Stopped Windows background startup task.\n");
      return 0;
    }
    process.stderr.write(`${result.stderr}\n`);
    return 1;
  }

  process.stderr.write("Usage: node scripts/windows-background.mjs [status|install|remove|start|stop]\n");
  return 1;
}

const currentModule = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === currentModule) {
  process.exitCode = runWindowsBackgroundCli(process.argv.slice(2));
}
