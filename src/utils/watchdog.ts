import { spawn } from "node:child_process";
import { log } from "./logger";
import { backoffDelay } from "./backoff";

const WORKER_SCRIPT = "src/utils/worker.ts";
const BASE_DELAY_MS = 30_000;
const MAX_CONSECUTIVE = 10;

let consecutive = 0;
let stopping = false;
let child: ReturnType<typeof spawn> | null = null;

function startWorker(): void {
  if (stopping) return;
  log.info("starting worker", { consecutive });

  child = spawn("tsx", [WORKER_SCRIPT], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  child.on("exit", (code, signal) => {
    if (stopping) {
      log.info("watchdog stopped");
      process.exit(0);
    }

    if (signal === "SIGTERM" || signal === "SIGINT") {
      log.info("worker exited from signal", { signal });
      process.exit(0);
    }

    if (code === 0) {
      consecutive = 0;
      log.warn("worker exited cleanly (unexpected), restarting");
      startWorker();
      return;
    }

    consecutive++;
    log.error("worker crashed", { code, consecutive });

    if (consecutive >= MAX_CONSECUTIVE) {
      log.error("worker crash limit reached, watchdog exiting");
      process.exit(1);
    }

    const delay = backoffDelay(consecutive, BASE_DELAY_MS);
    log.info("restarting worker after backoff", { delayMs: delay });
    setTimeout(startWorker, delay);
  });
}

function shutdown(signal: NodeJS.Signals): void {
  log.warn(`${signal} received, watchdog shutting down`);
  stopping = true;
  if (child) child.kill(signal);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

startWorker();