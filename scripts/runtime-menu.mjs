import { spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline/promises";

const BACKGROUND_MODE_ENV = "GPT_REPO_BACKGROUND_MODE";

export function shouldOfferRuntimeMenu() {
  return process.stdin.isTTY && process.stdout.isTTY && process.env[BACKGROUND_MODE_ENV] !== "1";
}

export function startDetachedCurrentScript(extraEnv = {}) {
  try {
    const child = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1], ...process.argv.slice(2)],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          ...extraEnv,
          [BACKGROUND_MODE_ENV]: "1"
        }
      }
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function maybePromptRuntimeMenu({
  appLabel,
  allowServiceInstall = false,
  installService,
  runServiceNow
}) {
  if (!shouldOfferRuntimeMenu()) {
    return "foreground";
  }

  const options = [
    "[1] Keep running in this terminal",
    "[2] Move to background and close this terminal",
    "[3] Stop now and close this terminal"
  ];

  if (allowServiceInstall) {
    options.push("[4] Install startup service (Task Scheduler)");
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n${appLabel} started. Choose next step:\n`);
    for (const option of options) {
      process.stdout.write(`  ${option}\n`);
    }

    const maxOption = allowServiceInstall ? "4" : "3";
    const answer = (await rl.question(`Select 1-${maxOption} (default 1): `)).trim();

    if (answer === "2") {
      if (!startDetachedCurrentScript()) {
        process.stderr.write("Could not start background process.\n");
        return "foreground";
      }
      process.stdout.write("Running in background. Closing this terminal session.\n");
      return "background";
    }

    if (answer === "3") {
      process.stdout.write("Stopping process and closing this terminal session.\n");
      return "exit";
    }

    if (allowServiceInstall && answer === "4" && installService && runServiceNow) {
      const installed = installService();
      if (!installed.ok) {
        process.stderr.write(`${installed.message}\n`);
        return "foreground";
      }
      process.stdout.write(`${installed.message}\n`);
      const runNow = (await rl.question("Start service now and close this terminal? [y/N]: ")).trim();
      if (/^y(es)?$/i.test(runNow)) {
        const started = runServiceNow();
        if (!started.ok) {
          process.stderr.write(`${started.message}\n`);
          return "foreground";
        }
        process.stdout.write(`${started.message}\n`);
        return "service-background";
      }
    }

    return "foreground";
  } finally {
    rl.close();
  }
}
