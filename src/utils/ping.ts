import { log } from "./logger";

export function startUptimePings(url: string, intervalMs: number): void {
  if (!url) return;
  log.info("uptime pings enabled", { url, intervalMs });

  const tick = async () => {
    try {
      await fetch(url, { method: "GET" });
    } catch (err) {
      log.warn("uptime ping failed", { err: String(err) });
    }
  };

  void tick();
  setInterval(tick, intervalMs).unref();
}