import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Transaction, parseEther, type JsonRpcProvider } from "ethers";
import { IntentGateway } from "../src/agent/intentGateway.js";
import { getChainConfig, type ChainKey } from "../src/chains/config.js";
import { EvmExecutor, type EvmExecutorLike, type EvmTxRequest } from "../src/chains/evmExecutor.js";
import { loadEnv } from "../src/config/env.js";
import { ErrorCode, GhostSignError } from "../src/errors.js";
import { DAY_MS, PolicyEngine, type PolicyConfig } from "../src/policy/guard.js";
import { NonceManager, NonceQueueFullError, type NonceSource } from "../src/services/nonceManager.js";
import { fakeMpc } from "./helpers/fakeMpc.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEST = "0x1111111111111111111111111111111111111111";
const env = loadEnv({ MPC_ROOT_PUBLIC_KEY: "secp256k1:x" }); // root key unused where passed explicitly

// ───────────────────────────────── NonceManager ─────────────────────────────────

describe("NonceManager", () => {
  const lagging: NonceSource = { getTransactionCount: async () => 0 }; // RPC that never sees our txs

  it("hands out sequential nonces to concurrent callers even when the RPC lags", async () => {
    const nm = new NonceManager();
    const order: number[] = [];
    const nonces = await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        nm.run(1n, "0xabc", lagging, async ({ nonce }) => {
          await sleep(5 - i); // later callers would finish first without the lock
          order.push(i);
          return nonce;
        }),
      ),
    );
    assert.deepEqual(nonces, [0, 1, 2, 3, 4]);
    assert.deepEqual(order, [0, 1, 2, 3, 4], "FIFO execution");
  });

  it("does not consume a nonce when the operation fails (no gaps)", async () => {
    const nm = new NonceManager();
    await assert.rejects(nm.run(1n, "0xabc", lagging, async () => Promise.reject(new Error("mpc down"))));
    assert.equal(await nm.run(1n, "0xabc", lagging, async ({ nonce }) => nonce), 0);
    assert.equal(await nm.run(1n, "0xabc", lagging, async ({ nonce }) => nonce), 1);
  });

  it("follows the chain when it is ahead (tx sent from elsewhere)", async () => {
    const nm = new NonceManager();
    let chain = 0;
    const src: NonceSource = { getTransactionCount: async () => chain };
    assert.equal(await nm.run(1n, "0xabc", src, async ({ nonce }) => nonce), 0);
    chain = 7;
    assert.equal(await nm.run(1n, "0xabc", src, async ({ nonce }) => nonce), 7);
  });

  it("runs different chains/addresses in parallel", async () => {
    const nm = new NonceManager();
    const t0 = Date.now();
    await Promise.all([
      nm.run(1n, "0xabc", lagging, () => sleep(60)),
      nm.run(2n, "0xabc", lagging, () => sleep(60)),
      nm.run(1n, "0xdef", lagging, () => sleep(60)),
    ]);
    assert.ok(Date.now() - t0 < 150, "lanes should not block each other");
  });

  it("applies back-pressure when a lane is full", async () => {
    const nm = new NonceManager({ maxQueueDepth: 2 });
    const slow = [nm.run(1n, "0xabc", lagging, () => sleep(30)), nm.run(1n, "0xabc", lagging, () => sleep(30))];
    await assert.rejects(nm.run(1n, "0xabc", lagging, async () => 0), NonceQueueFullError);
    await Promise.all(slow);
  });
});

// ───────────────────────────────── PolicyEngine ─────────────────────────────────

function policy(over: Partial<PolicyConfig> = {}, now?: () => number) {
  return new PolicyEngine(
    {
      maxPerTxWei: parseEther("0.01"),
      dailyCapWei: parseEther("0.05"),
      strictMode: false,
      allowlist: [],
      denylist: [],
      frozen: false,
      ...over,
    },
    now ? { now } : {},
  );
}

const code = (fn: () => unknown) => {
  try {
    fn();
    return "OK";
  } catch (e) {
    return e instanceof GhostSignError ? e.code : "UNKNOWN";
  }
};

describe("PolicyEngine", () => {
  const req = (amount: string, chain: ChainKey = "ethereum-sepolia", to = DEST) => ({ chain, to, valueWei: parseEther(amount) });

  it("enforces the per-transaction cap", () => {
    const p = policy();
    assert.equal(code(() => p.check(req("0.01"))), "OK");
    assert.equal(code(() => p.check(req("0.010000000000000001"))), ErrorCode.SPEND_CAP_EXCEEDED);
  });

  it("enforces a rolling 24h cap per chain, aging out old spends", () => {
    let t = 1_000_000;
    const p = policy({}, () => t);
    for (let i = 0; i < 5; i++) p.reserve(req("0.01")).commit();
    assert.equal(code(() => p.check(req("0.000001"))), ErrorCode.DAILY_CAP_EXCEEDED);
    assert.equal(code(() => p.check(req("0.01", "base-sepolia"))), "OK", "caps are per chain");
    t += DAY_MS - 1;
    assert.equal(code(() => p.check(req("0.000001"))), ErrorCode.DAILY_CAP_EXCEEDED, "still inside window");
    t += 1;
    assert.equal(code(() => p.check(req("0.01"))), "OK", "window rolled over");
  });

  it("counts open reservations so concurrent intents cannot overspend; release refunds", () => {
    const p = policy();
    const held = [1, 2, 3, 4, 5].map(() => p.reserve(req("0.01")));
    assert.equal(code(() => p.reserve(req("0.01"))), ErrorCode.DAILY_CAP_EXCEEDED);
    held[0]!.release();
    held[0]!.release(); // idempotent
    assert.equal(code(() => p.reserve(req("0.01"))), "OK");
  });

  it("blocks zero, burn, and denylisted destinations", () => {
    const p = policy({ denylist: ["0x2222222222222222222222222222222222222222"] });
    for (const to of [
      "0x0000000000000000000000000000000000000000",
      "0x000000000000000000000000000000000000dEaD",
      "0x2222222222222222222222222222222222222222",
      "not-an-address",
    ]) {
      assert.equal(code(() => p.check(req("0.001", "ethereum-sepolia", to))), ErrorCode.DESTINATION_NOT_ALLOWED, to);
    }
  });

  it("strict mode only allows allowlisted destinations, and burn addresses stay blocked", () => {
    const p = policy({ strictMode: true, allowlist: [DEST, "0x000000000000000000000000000000000000dead"] });
    assert.equal(code(() => p.check(req("0.001"))), "OK");
    assert.equal(
      code(() => p.check(req("0.001", "ethereum-sepolia", "0x3333333333333333333333333333333333333333"))),
      ErrorCode.DESTINATION_NOT_ALLOWED,
    );
    assert.equal(
      code(() => p.check(req("0.001", "ethereum-sepolia", "0x000000000000000000000000000000000000dEaD"))),
      ErrorCode.DESTINATION_NOT_ALLOWED,
    );
  });

  it("kill switch blocks everything and takes priority", () => {
    const p = policy({ frozen: true });
    assert.equal(code(() => p.check(req("999"))), ErrorCode.KILL_SWITCH_ACTIVE);
    p.unfreeze();
    assert.equal(code(() => p.check(req("0.001"))), "OK");
    p.freeze("incident");
    assert.equal(p.isFrozen, true);
    assert.equal(code(() => p.reserve(req("0.001"))), ErrorCode.KILL_SWITCH_ACTIVE);
  });

  it("reads limits and flags from env", () => {
    const p = PolicyEngine.fromEnv(
      loadEnv({ MPC_ROOT_PUBLIC_KEY: "secp256k1:x", POLICY_MAX_PER_TX_ETH: "0.002", GHOSTSIGN_FROZEN: "true" }),
    );
    assert.equal(p.limitsFor("base-sepolia").maxPerTxWei, parseEther("0.002"));
    assert.equal(p.isFrozen, true);
  });
});

// ───────────────────────────────── IntentGateway ─────────────────────────────────

function fakeExecutor(chain: ChainKey, opts: { balance?: bigint; sendError?: GhostSignError } = {}) {
  const sent: EvmTxRequest[] = [];
  const ex: EvmExecutorLike & { sent: EvmTxRequest[] } = {
    sent,
    chain: getChainConfig(chain, env),
    addressFor: () => "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
    getBalance: async () => opts.balance ?? parseEther("1"),
    send: async (_path, req) => {
      if (opts.sendError) throw opts.sendError;
      sent.push(req);
      return {
        chain,
        from: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
        to: req.to as `0x${string}`,
        nonce: sent.length - 1,
        txHash: `0x${"ab".repeat(32)}`,
        explorerUrl: `x/tx/0x${"ab".repeat(32)}`,
        nearTxHash: "near",
        rawTransaction: "0x",
      };
    },
  };
  return ex;
}

describe("IntentGateway", () => {
  const intent = (over: Record<string, unknown> = {}) => ({
    chain: "ethereum-sepolia",
    to: DEST,
    amount: "0.001",
    reason: "pay for API credits",
    ...over,
  });

  it("executes a valid intent and returns the documented shape", async () => {
    const eth = fakeExecutor("ethereum-sepolia");
    const g = new IntentGateway({ policy: policy(), executors: { "ethereum-sepolia": eth } });
    const r = await g.execute(intent());
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.chain, "ethereum-sepolia");
    assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
    assert.ok(r.explorerUrl.includes(r.txHash));
    assert.equal(typeof r.executionTimeMs, "number");
    assert.equal(eth.sent[0]!.value, parseEther("0.001"));
  });

  it("rejects policy violations before any signing", async () => {
    const eth = fakeExecutor("ethereum-sepolia");
    const p = policy();
    const g = new IntentGateway({ policy: p, executors: { "ethereum-sepolia": eth } });

    const over = await g.execute(intent({ amount: "0.5" }));
    const burn = await g.execute(intent({ to: "0x000000000000000000000000000000000000dEaD" }));
    p.freeze();
    const frozen = await g.execute(intent());

    for (const [r, c] of [
      [over, ErrorCode.SPEND_CAP_EXCEEDED],
      [burn, ErrorCode.DESTINATION_NOT_ALLOWED],
      [frozen, ErrorCode.KILL_SWITCH_ACTIVE],
    ] as const) {
      assert.equal(r.success, false);
      if (r.success) continue;
      assert.equal(r.code, c);
      assert.equal(r.rejectedBeforeSigning, true);
    }
    assert.equal(eth.sent.length, 0, "executor never reached");
  });

  it("validates intent shape strictly", async () => {
    const g = new IntentGateway({ policy: policy(), executors: {} });
    for (const bad of [
      intent({ chain: "polygon" }),
      intent({ to: "0x123" }),
      intent({ amount: "1e18" }),
      intent({ amount: "0" }),
      intent({ reason: "" }),
      intent({ extra: true }),
      intent({ derivationPath: "a b" }),
    ]) {
      const r = await g.execute(bad);
      assert.equal(r.success, false);
      if (!r.success) assert.equal(r.code, ErrorCode.INVALID_INTENT, JSON.stringify(bad));
    }
  });

  it("fails fast on insufficient balance and refunds the reservation", async () => {
    const p = policy({ dailyCapWei: parseEther("0.001") });
    const g = new IntentGateway({ policy: p, executors: { "ethereum-sepolia": fakeExecutor("ethereum-sepolia", { balance: 0n }) } });
    const r = await g.execute(intent());
    assert.equal(!r.success && r.code, ErrorCode.INSUFFICIENT_FUNDS);
    assert.equal(p.spentInWindow("ethereum-sepolia"), 0n);
  });

  it("refunds the cap on MPC failure but keeps it on an ambiguous broadcast failure", async () => {
    const p1 = policy();
    await new IntentGateway({
      policy: p1,
      executors: { "ethereum-sepolia": fakeExecutor("ethereum-sepolia", { sendError: new GhostSignError(ErrorCode.MPC_SIGNING_FAILED, "x") }) },
    }).execute(intent());
    assert.equal(p1.spentInWindow("ethereum-sepolia"), 0n);

    const p2 = policy();
    await new IntentGateway({
      policy: p2,
      executors: { "ethereum-sepolia": fakeExecutor("ethereum-sepolia", { sendError: new GhostSignError(ErrorCode.BROADCAST_FAILED, "x") }) },
    }).execute(intent());
    assert.equal(p2.spentInWindow("ethereum-sepolia"), parseEther("0.001"));
  });
});

// ───────────────────────── EvmExecutor end-to-end (fake chain + fake MPC) ─────────────────────────

/** Minimal in-memory EVM node: validates nonce ordering like a real mempool. */
function fakeChain(chainId: bigint, balanceWei: bigint) {
  const pool: Transaction[] = [];
  let lagging = true; // getTransactionCount never sees the mempool, like a lagging RPC
  const provider = {
    send: async (method: string) => {
      if (method !== "eth_chainId") throw new Error(method);
      return `0x${chainId.toString(16)}`;
    },
    getFeeData: async () => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, gasPrice: 1_000_000_000n }),
    getBalance: async () => balanceWei,
    estimateGas: async () => 21_000n,
    getTransactionCount: async () => (lagging ? 0 : pool.length),
    broadcastTransaction: async (raw: string) => {
      const tx = Transaction.from(raw);
      if (tx.nonce !== pool.length) throw new Error(`nonce ${tx.nonce} != expected ${pool.length}`);
      pool.push(tx);
      return { hash: tx.hash! };
    },
  };
  return { provider: provider as unknown as JsonRpcProvider, pool, setLagging: (v: boolean) => (lagging = v) };
}

describe("EvmExecutor (multi-chain)", () => {
  const mpc = fakeMpc(0x5eed5eed5eedn);
  const account = "ghostsign-agent.testnet";

  it("derives the same address on Ethereum Sepolia and Base Sepolia", () => {
    const nm = new NonceManager();
    const signer = mpc.signerFor(account);
    const mk = (c: ChainKey) =>
      new EvmExecutor({ chain: getChainConfig(c, env), signer, rootPublicKey: mpc.rootNear, nonceManager: nm, provider: fakeChain(1n, 0n).provider });
    assert.equal(mk("ethereum-sepolia").addressFor("ethereum-1"), mk("base-sepolia").addressFor("ethereum-1"));
  });

  it("serialises concurrent sends into consecutive nonces with valid signatures per chain", async () => {
    const nm = new NonceManager();
    const signer = mpc.signerFor(account, { delayMs: 10 });
    const eth = fakeChain(11155111n, parseEther("1"));
    const base = fakeChain(84532n, parseEther("1"));
    const exEth = new EvmExecutor({ chain: getChainConfig("ethereum-sepolia", env), signer, rootPublicKey: mpc.rootNear, nonceManager: nm, provider: eth.provider });
    const exBase = new EvmExecutor({ chain: getChainConfig("base-sepolia", env), signer, rootPublicKey: mpc.rootNear, nonceManager: nm, provider: base.provider });
    const from = exEth.addressFor("ethereum-1");

    const results = await Promise.all([
      ...[1, 2, 3, 4].map((i) => exEth.send("ethereum-1", { to: DEST, value: BigInt(i) })),
      ...[1, 2].map((i) => exBase.send("ethereum-1", { to: DEST, value: BigInt(i) })),
    ]);

    assert.deepEqual(eth.pool.map((t) => t.nonce), [0, 1, 2, 3]);
    assert.deepEqual(base.pool.map((t) => t.nonce), [0, 1]);
    for (const t of [...eth.pool, ...base.pool]) assert.equal(t.from, from, "signature recovers to derived address");
    assert.deepEqual(eth.pool.map((t) => t.chainId), [11155111n, 11155111n, 11155111n, 11155111n]);
    assert.deepEqual(base.pool.map((t) => t.chainId), [84532n, 84532n]);
    assert.ok(results.find((r) => r.chain === "base-sepolia")!.explorerUrl.startsWith("https://sepolia.basescan.org/tx/"));
  });

  it("retries the same nonce after an MPC failure (no gap)", async () => {
    let failNext = true;
    const signer = mpc.signerFor(account, { fail: () => (failNext ? ((failNext = false), true) : false) });
    const chain = fakeChain(11155111n, parseEther("1"));
    const ex = new EvmExecutor({ chain: getChainConfig("ethereum-sepolia", env), signer, rootPublicKey: mpc.rootNear, nonceManager: new NonceManager(), provider: chain.provider });
    await assert.rejects(ex.send("ethereum-1", { to: DEST, value: 1n }), (e: unknown) => e instanceof GhostSignError && e.code === ErrorCode.MPC_SIGNING_FAILED);
    const ok = await ex.send("ethereum-1", { to: DEST, value: 1n });
    assert.equal(ok.nonce, 0);
  });

  it("refuses to sign when balance cannot cover value + worst-case gas", async () => {
    const signer = mpc.signerFor(account);
    const ex = new EvmExecutor({
      chain: getChainConfig("base-sepolia", env),
      signer,
      rootPublicKey: mpc.rootNear,
      nonceManager: new NonceManager(),
      provider: fakeChain(84532n, 1000n).provider,
    });
    await assert.rejects(ex.send("ethereum-1", { to: DEST, value: 1n }), (e: unknown) => e instanceof GhostSignError && e.code === ErrorCode.INSUFFICIENT_FUNDS);
    assert.equal(signer.calls, 0, "MPC never called");
  });

  it("rejects an RPC that is on the wrong chain", async () => {
    const ex = new EvmExecutor({
      chain: getChainConfig("base-sepolia", env),
      signer: mpc.signerFor(account),
      rootPublicKey: mpc.rootNear,
      nonceManager: new NonceManager(),
      provider: fakeChain(1n, parseEther("1")).provider,
    });
    await assert.rejects(ex.send("ethereum-1", { to: DEST, value: 1n }), (e: unknown) => e instanceof GhostSignError && e.code === ErrorCode.CHAIN_MISMATCH);
  });
});
