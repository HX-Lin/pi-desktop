#!/usr/bin/env node
/* global setInterval, clearInterval -- waitForMain uses a polling interval. */
/**
 * Dev orchestration: Vite (renderer) + tsup watch (main/preload/host) + Electron.
 */
import { spawn } from "child_process";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

const children = [];

// Strip PI_DESKTOP_* pollution from the user shell (these stale values break
// the hosted toolchain/version checks during build and tests).
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_DESKTOP_")));

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
    env: { ...cleanEnv, ...opts.env },
  });
  children.push(child);
  child.on("exit", (code) => {
    if (opts.fatal !== false && code && code !== 0) {
      console.error(`[dev] ${cmd} exited ${code}`);
      shutdown(code);
    }
  });
  return child;
}

function shutdown(code = 0) {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// 1) Build main/preload/host once. We deliberately do NOT run `tsup --watch`
// alongside Vite: multiple esbuild (Go) services competing at once can
// deadlock ("all goroutines are asleep"), and the watcher's `clean` step can
// race the build and delete out/main/main.js before Electron starts.
console.log("[dev] building main/preload/host…");
const build = spawn("npx", ["tsup", "--config", "tsup.config.ts"], {
  cwd: root,
  stdio: "inherit",
  shell: isWin,
  env: cleanEnv,
});
build.on("exit", (code) => {
  if (code !== 0) {
    console.error("[dev] initial tsup failed");
    process.exit(code ?? 1);
  }

  // Make sure the entry point actually exists (tsup can report success while
  // esbuild crashed mid-write on some machines).
  const mainEntry = path.join(root, "out", "main", "main.js");
  let waited = 0;
  const waitForMain = setInterval(() => {
    waited += 500;
    if (fs.existsSync(mainEntry)) {
      clearInterval(waitForMain);
      startDev();
      return;
    }
    if (waited >= 15000) {
      clearInterval(waitForMain);
      console.error(`[dev] ${mainEntry} was not produced after build — tsup/esbuild may have crashed.`);
      process.exit(1);
    }
  }, 500);
});

function startDev() {
  console.log("[dev] main bundle ready — starting vite + electron…");
  run("npx", ["vite", "--config", "vite.config.ts"], { fatal: false });

  // Wait for vite, then launch electron
  setTimeout(() => {
    console.log("[dev] starting electron…");
    run(path.join(root, "node_modules", ".bin", isWin ? "electron.cmd" : "electron"), ["."], {
      env: {
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      },
    });
  }, 2500);
}
