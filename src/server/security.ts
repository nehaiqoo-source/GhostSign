/**
 * Request guards for the dashboard API: judge access code, per-IP rate limits, same-origin check.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const ACCESS_HEADER = "x-ghostsign-access";

/** Constant-time comparison of the supplied access code with the configured one. */
export function checkAccessCode(supplied: unknown, expected: string | undefined): boolean {
  if (!expected) return true; // local mode: no code configured
  if (typeof supplied !== "string" || supplied.length === 0 || supplied.length > 256) return false;
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Client IP. Behind a platform proxy (Railway) the left-most X-Forwarded-For entry is the client. */
export function clientIp(req: IncomingMessage, behindProxy: boolean): string {
  if (behindProxy) {
    const fwd = req.headers["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Browser requests may only mutate state from the same origin (or loopback in local dev).
 * Requests without an Origin header (curl, server-to-server) still need the access code in public mode.
 */
export function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const hostname = host.replace(/:\d+$/, "");
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
  return host === req.headers.host;
}

/** Fixed-window counter per key. Small and dependency-free; fine for a single instance. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 0 if allowed (and records the hit), otherwise seconds until the window resets. */
  take(key: string): number {
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(t);
      return 0;
    }
    if (cur.count >= this.limit) return Math.ceil((cur.resetAt - t) / 1000);
    cur.count++;
    return 0;
  }

  private sweep(t: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
