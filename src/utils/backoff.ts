import { retryBaseMs, retryCapMs } from "./config";

export function backoffDelay(attempt: number, baseMs: number = retryBaseMs, capMs: number = retryCapMs): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = exp * (0.75 + Math.random() * 0.5);
  return Math.min(jitter, capMs);
}