import { strict as assert } from "node:assert";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { RateLimiter, checkAccessCode, clientIp, isAllowedOrigin } from "../src/server/security.js";

const req = (headers: Record<string, string>, remoteAddress = "10.0.0.1") =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

describe("server security guards", () => {
  it("access code: required when configured, constant-time match", () => {
    assert.equal(checkAccessCode(undefined, undefined), true, "local mode has no code");
    assert.equal(checkAccessCode("judge-code-123", "judge-code-123"), true);
    assert.equal(checkAccessCode("judge-code-12", "judge-code-123"), false);
    assert.equal(checkAccessCode(undefined, "judge-code-123"), false);
    assert.equal(checkAccessCode(["judge-code-123"], "judge-code-123"), false);
    assert.equal(checkAccessCode("x".repeat(300), "judge-code-123"), false);
  });

  it("origin: same-origin and loopback only", () => {
    assert.equal(isAllowedOrigin(req({})), true);
    assert.equal(isAllowedOrigin(req({ origin: "http://localhost:5173", host: "127.0.0.1:8787" })), true);
    assert.equal(isAllowedOrigin(req({ origin: "https://ghostsign.up.railway.app", host: "ghostsign.up.railway.app" })), true);
    assert.equal(isAllowedOrigin(req({ origin: "https://evil.example", host: "ghostsign.up.railway.app" })), false);
    assert.equal(isAllowedOrigin(req({ origin: "null", host: "ghostsign.up.railway.app" })), false);
  });

  it("client ip: trusts X-Forwarded-For only behind a proxy", () => {
    const r = req({ "x-forwarded-for": "1.2.3.4, 10.0.0.9" });
    assert.equal(clientIp(r, true), "1.2.3.4");
    assert.equal(clientIp(r, false), "10.0.0.1");
  });

  it("rate limiter: fixed window per key", () => {
    let t = 0;
    const rl = new RateLimiter(2, 60_000, () => t);
    assert.equal(rl.take("a"), 0);
    assert.equal(rl.take("a"), 0);
    assert.equal(rl.take("a"), 60);
    assert.equal(rl.take("b"), 0, "keys are independent");
    t = 60_000;
    assert.equal(rl.take("a"), 0, "window reset");
  });
});
