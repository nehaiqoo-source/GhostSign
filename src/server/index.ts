/**
 * GhostSign API + dashboard server.
 *
 * LOCAL mode (default): binds 127.0.0.1, no access code.
 * PUBLIC mode (HOST is not loopback, e.g. on Railway, or GHOSTSIGN_PUBLIC_MODE=true): this process holds the NEAR key that
 * authorises MPC signatures, so it fails closed:
 *   - refuses to start without GHOSTSIGN_ACCESS_CODE (≥ 8 chars); every POST needs it
 *   - forces strict allowlist mode; default allowlist = the agent's own treasury address
 *   - caps clamped to a public ceiling (default 0.001 ETH/tx, 0.01 ETH/24h; GHOSTSIGN_PUBLIC_* to change)
 *   - per-IP and global rate limits; same-origin only for browser POSTs
 *
 *   GET  /api/health           liveness
 *
 *   GET  /api/state            agent identity, chains, policy
 *   GET  /api/balances         live balances (EVM chains + NEAR)
 *   GET  /api/feed             audit feed
 *   GET  /api/events           server-sent events: feed + policy updates
 *   POST /api/intents          { chain, to, amount, reason } → 202 { id }
 *   POST /api/policy/freeze    { frozen: boolean, reason?: string }
 *
 * In production mode it also serves the built dashboard from dashboard/dist.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther, parseEther } from "ethers";
import { JsonRpcProvider as NearRpcProvider } from "near-api-js";
import { IntentGateway, type IntentResult, type IntentStage } from "../agent/intentGateway.js";
import { SUPPORTED_CHAINS, getChainConfig, txExplorerUrl } from "../chains/config.js";
import { loadEnv, requireEnv } from "../config/env.js";
import { deriveChildPublicKey } from "../crypto/kdf.js";
import { PolicyEngine } from "../policy/guard.js";
import { PROOF_AGENT_ACCOUNT, PROVEN_TXS } from "./history.js";
import { ACCESS_HEADER, RateLimiter, checkAccessCode, clientIp, isAllowedOrigin } from "./security.js";

const baseEnv = loadEnv();
const PORT = Number(process.env.PORT ?? process.env.GHOSTSIGN_API_PORT ?? 8787);
const HOST = process.env.HOST ?? (process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1");
const PUBLIC = /^(1|true|yes)$/i.test(process.env.GHOSTSIGN_PUBLIC_MODE ?? "") || !["127.0.0.1", "localhost", "::1"].includes(HOST);
const ACCESS_CODE = process.env.GHOSTSIGN_ACCESS_CODE?.trim() || undefined;
const AGENT_PATH = "ethereum-1";
const TREASURY_PATH = "ethereum-2";
const MAX_BODY = 16 * 1024;
const MAX_FEED = 200;
const DASHBOARD_DIST = resolve(fileURLToPath(new URL("../../dashboard/dist", import.meta.url)));

const nearAccount = requireEnv(baseEnv, "NEAR_ACCOUNT_ID");
const agentKey = deriveChildPublicKey(baseEnv.MPC_ROOT_PUBLIC_KEY, nearAccount, AGENT_PATH);
const treasury = deriveChildPublicKey(baseEnv.MPC_ROOT_PUBLIC_KEY, nearAccount, TREASURY_PATH).ethereumAddress;

function minEth(a: string, b: string): string {
  return parseEther(a) <= parseEther(b) ? a : b;
}

if (PUBLIC && (!ACCESS_CODE || ACCESS_CODE.length < 8)) {
  console.error("Refusing to start in public mode: set GHOSTSIGN_ACCESS_CODE (at least 8 characters).");
  process.exit(1);
}

/** Public mode hardens the policy regardless of what the env says. */
const env = PUBLIC
  ? {
      ...baseEnv,
      POLICY_STRICT_MODE: true,
      POLICY_ALLOWLIST: baseEnv.POLICY_ALLOWLIST?.length ? baseEnv.POLICY_ALLOWLIST : [treasury.toLowerCase()],
      // Caps can only be lowered in public mode, never raised above the public ceiling.
      POLICY_MAX_PER_TX_ETH: minEth(baseEnv.POLICY_MAX_PER_TX_ETH, process.env.GHOSTSIGN_PUBLIC_MAX_PER_TX_ETH ?? "0.001"),
      POLICY_DAILY_CAP_ETH: minEth(baseEnv.POLICY_DAILY_CAP_ETH, process.env.GHOSTSIGN_PUBLIC_DAILY_CAP_ETH ?? "0.01"),
    }
  : baseEnv;

const gateway = IntentGateway.fromEnv({ env, policy: PolicyEngine.fromEnv(env) });

const limits = {
  intentsPerIp: new RateLimiter(PUBLIC ? 5 : 1000, 10 * 60_000),
  intentsGlobal: new RateLimiter(PUBLIC ? 40 : 100_000, 60 * 60_000),
  freezePerIp: new RateLimiter(PUBLIC ? 20 : 1000, 10 * 60_000),
  authPerIp: new RateLimiter(PUBLIC ? 10 : 1000, 10 * 60_000),
};
const nearProvider = new NearRpcProvider({ url: env.NEAR_NODE_URL });

// ───────────────────────────── audit feed ─────────────────────────────

type StageName = IntentStage["stage"] | "confirmed";
type EntryStatus = "running" | "broadcast" | "confirmed" | "blocked" | "failed";

interface FeedEntry {
  id: string;
  source: "dashboard" | "cli-history";
  createdAt: number;
  chain: string;
  to: string;
  amount: string;
  reason: string;
  status: EntryStatus;
  stages: Array<{ stage: StageName; at: number }>;
  from?: string;
  nonce?: number;
  txHash?: string;
  explorerUrl?: string;
  nearTxHash?: string;
  blockNumber?: number;
  code?: string;
  error?: string;
  rejectedBeforeSigning?: boolean;
  executionTimeMs?: number;
}

const feed: FeedEntry[] = [];

if (nearAccount === PROOF_AGENT_ACCOUNT) {
  // Oldest first so the newest ends up on top after unshift.
  PROVEN_TXS.forEach((p, i) => {
    const chain = getChainConfig(p.chain, env);
    feed.unshift({
      id: `history-${i}`,
      source: "cli-history",
      createdAt: 0,
      chain: p.chain,
      to: treasury,
      amount: p.amount,
      reason: p.reason,
      status: "confirmed",
      stages: [],
      from: agentKey.ethereumAddress,
      nonce: p.nonce,
      txHash: p.txHash,
      explorerUrl: txExplorerUrl(chain, p.txHash),
      nearTxHash: p.nearTxHash,
      blockNumber: p.blockNumber,
    });
  });
}

// ───────────────────────────── SSE ─────────────────────────────

const clients = new Set<ServerResponse>();

function publish(event: string, data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 25_000).unref();

function upsert(entry: FeedEntry): void {
  if (!feed.includes(entry)) {
    feed.unshift(entry);
    if (feed.length > MAX_FEED) feed.length = MAX_FEED;
  }
  publish("entry", entry);
}

// ───────────────────────────── views ─────────────────────────────

function policyView() {
  const s = gateway.policy.status(SUPPORTED_CHAINS);
  return {
    frozen: s.frozen,
    frozenReason: s.frozenReason ?? null,
    strictMode: s.strictMode,
    chains: Object.fromEntries(
      Object.entries(s.chains).map(([k, v]) => [
        k,
        {
          maxPerTx: formatEther(v.maxPerTxWei),
          dailyCap: formatEther(v.dailyCapWei),
          spent: formatEther(v.spentWei),
          remaining: formatEther(v.remainingWei),
        },
      ]),
    ),
  };
}

function stateView() {
  return {
    mode: PUBLIC ? "public" : "local",
    accessRequired: !!ACCESS_CODE,
    network: env.NEAR_NETWORK_ID,
    mpcContract: env.MPC_CONTRACT_ID,
    nearAccount,
    agent: {
      path: AGENT_PATH,
      address: agentKey.ethereumAddress,
      publicKey: agentKey.nearPublicKey,
      compressedPublicKey: agentKey.compressedPublicKey,
    },
    treasury: { path: TREASURY_PATH, address: treasury },
    chains: SUPPORTED_CHAINS.map((k) => {
      const c = getChainConfig(k, env);
      return { key: c.key, name: c.name, chainId: c.chainId.toString(), currency: c.currency, explorerUrl: c.explorerUrl };
    }),
    policy: policyView(),
  };
}

async function balancesView() {
  const evm = await Promise.all(
    SUPPORTED_CHAINS.map(async (k) => {
      try {
        const wei = (await gateway.executor(k)?.getBalance(agentKey.ethereumAddress)) ?? 0n;
        return [k, { ok: true, eth: formatEther(wei) }] as const;
      } catch (err) {
        return [k, { ok: false, error: err instanceof Error ? err.message : String(err) }] as const;
      }
    }),
  );
  let near: { ok: boolean; near?: string; error?: string };
  try {
    const acct = await nearProvider.viewAccount({ accountId: nearAccount });
    near = { ok: true, near: (Number(BigInt(acct.amount) / 10n ** 18n) / 1e6).toFixed(4) };
  } catch (err) {
    near = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { address: agentKey.ethereumAddress, chains: Object.fromEntries(evm), near, at: Date.now() };
}

// ───────────────────────────── intents ─────────────────────────────

function startIntent(body: Record<string, unknown>): FeedEntry {
  const entry: FeedEntry = {
    id: randomUUID(),
    source: "dashboard",
    createdAt: Date.now(),
    chain: String(body.chain ?? ""),
    to: String(body.to ?? ""),
    amount: String(body.amount ?? ""),
    reason: String(body.reason ?? ""),
    status: "running",
    stages: [],
  };
  upsert(entry);

  void (async () => {
    const result: IntentResult = await gateway.execute(body, {
      onStage: (s) => {
        entry.stages.push({ stage: s.stage, at: Date.now() });
        if (s.stage === "policy_passed") entry.from = s.from;
        if (s.stage === "nonce_acquired") entry.nonce = s.nonce;
        if (s.stage === "mpc_signed") entry.nearTxHash = s.nearTxHash;
        if (s.stage === "broadcast") {
          entry.txHash = s.txHash;
          entry.explorerUrl = s.explorerUrl;
          entry.status = "broadcast";
        }
        upsert(entry);
      },
    });

    entry.executionTimeMs = result.executionTimeMs;
    if (!result.success) {
      entry.status = result.rejectedBeforeSigning ? "blocked" : "failed";
      entry.code = result.code;
      entry.error = result.error;
      entry.rejectedBeforeSigning = result.rejectedBeforeSigning;
      upsert(entry);
      publish("policy", policyView());
      return;
    }
    publish("policy", policyView());

    const executor = gateway.executor(result.chain);
    try {
      const conf = await executor?.waitForConfirmation?.(result.txHash);
      if (conf) {
        entry.blockNumber = conf.blockNumber;
        entry.status = conf.status === "success" ? "confirmed" : "failed";
        if (conf.status === "reverted") entry.error = "Transaction reverted on-chain";
        entry.stages.push({ stage: "confirmed", at: Date.now() });
      }
    } catch (err) {
      entry.error = `Broadcast OK, confirmation not observed yet: ${err instanceof Error ? err.message : String(err)}`;
    }
    upsert(entry);
  })().catch((err: unknown) => {
    entry.status = "failed";
    entry.error = err instanceof Error ? err.message : String(err);
    upsert(entry);
  });

  return entry;
}

// ───────────────────────────── http plumbing ─────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function serveStatic(pathname: string, res: ServerResponse): boolean {
  if (!existsSync(DASHBOARD_DIST)) return false;
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(DASHBOARD_DIST, rel);
  if (!file.startsWith(DASHBOARD_DIST)) return false; // path traversal
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DASHBOARD_DIST, "index.html"); // SPA fallback
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
  return true;
}

const server = createServer((req, res) => {
  void (async () => {
    const ip = clientIp(req, PUBLIC);
    const limit = (rl: RateLimiter, key: string) => {
      const wait = rl.take(key);
      if (wait > 0) throw new HttpError(429, `Rate limit reached, try again in ${wait}s`);
    };
    try {
      // Fixed base: HOST may be an IPv6 literal ("::"), which is not a valid URL host.
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;
      if (req.method === "POST") {
        if (!isAllowedOrigin(req)) throw new HttpError(403, "Cross-origin requests are not allowed");
        if (route !== "POST /api/auth/check" && !checkAccessCode(req.headers[ACCESS_HEADER], ACCESS_CODE)) {
          limit(limits.authPerIp, ip);
          throw new HttpError(401, "Access code required");
        }
      }

      switch (route) {
        case "GET /api/health":
          return json(res, 200, { ok: true });
        case "POST /api/auth/check": {
          limit(limits.authPerIp, ip);
          const body = await readJson(req);
          if (!checkAccessCode(body.code, ACCESS_CODE)) throw new HttpError(401, "Wrong access code");
          return json(res, 200, { ok: true });
        }
        case "GET /api/state":
          return json(res, 200, stateView());
        case "GET /api/balances":
          return json(res, 200, await balancesView());
        case "GET /api/feed":
          return json(res, 200, feed);
        case "GET /api/events": {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          });
          res.write(`event: hello\ndata: ${JSON.stringify({ policy: policyView() })}\n\n`);
          clients.add(res);
          req.on("close", () => clients.delete(res));
          return;
        }
        case "POST /api/intents": {
          limit(limits.intentsPerIp, ip);
          limit(limits.intentsGlobal, "global");
          const body = await readJson(req);
          const entry = startIntent(body);
          return json(res, 202, { id: entry.id });
        }
        case "POST /api/policy/freeze": {
          limit(limits.freezePerIp, ip);
          const body = await readJson(req);
          if (typeof body.frozen !== "boolean") throw new HttpError(400, "'frozen' must be a boolean");
          if (body.frozen) gateway.policy.freeze(typeof body.reason === "string" ? body.reason.slice(0, 200) : "dashboard kill switch");
          else gateway.policy.unfreeze();
          const p = policyView();
          publish("policy", p);
          return json(res, 200, p);
        }
        default:
          if (url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found");
          if (req.method === "GET" && serveStatic(url.pathname, res)) return;
          throw new HttpError(404, existsSync(DASHBOARD_DIST) ? "Not found" : "Dashboard not built: run `npm run dashboard`");
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) json(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  })().catch((err: unknown) => {
    // Last resort: never let one request take the process down.
    console.error("request handler failed:", err);
    if (!res.headersSent) res.writeHead(500).end();
    else res.end();
  });
});

process.on("unhandledRejection", (err) => console.error("unhandled rejection:", err));

server.listen(PORT, HOST, () => {
  console.log(`GhostSign API on http://${HOST}:${PORT} (${PUBLIC ? "PUBLIC mode: access code + strict allowlist" : "local mode"})`);
  console.log(`  agent ${agentKey.ethereumAddress} (${nearAccount} / ${AGENT_PATH})`);
  console.log(`  MPC   ${env.MPC_CONTRACT_ID} on NEAR ${env.NEAR_NETWORK_ID}`);
  if (existsSync(DASHBOARD_DIST)) console.log(`  serving dashboard from ${DASHBOARD_DIST}`);
});

export type { FeedEntry };
