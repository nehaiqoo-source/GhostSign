/**
 * Per-(chain, address) serial queue + nonce allocator.
 *
 * Why: an MPC signature is bound to a nonce. If two intents for the same derived address are
 * built concurrently they read the same `pending` count, get two signatures for the same nonce,
 * and one transaction is silently dropped (or replaces the other). We therefore run the whole
 * "allocate nonce → MPC sign → broadcast" critical section one-at-a-time per lane.
 *
 * Nonce choice inside the lock: max(on-chain pending count, local next nonce). The local value
 * covers load-balanced RPCs whose mempool view lags our own broadcasts; the on-chain value covers
 * transactions sent from the same address by something else.
 *
 * Failure semantics — never create a nonce gap (a gap stalls every later tx):
 *   - `fn` resolves → nonce consumed, local next = nonce + 1
 *   - `fn` throws   → nonce NOT consumed locally, whether it failed before or during broadcast.
 *     If an "ambiguous" broadcast actually landed, the next attempt re-reads `pending` (or the
 *     node answers "nonce too low" / "already known", a safe rejection — never a double spend).
 */
export interface NonceSource {
  getTransactionCount(address: string, blockTag: "pending"): Promise<number>;
}

export interface NonceLease {
  readonly nonce: number;
}

interface Lane {
  tail: Promise<void>;
  nextNonce: number | undefined;
  depth: number;
}

export interface NonceManagerOptions {
  /** Max queued operations per lane before new work is rejected (back-pressure). Default 32. */
  maxQueueDepth?: number;
}

export class NonceQueueFullError extends Error {
  constructor(readonly laneKey: string, readonly depth: number) {
    super(`Transaction queue for ${laneKey} is full (${depth} pending)`);
    this.name = "NonceQueueFullError";
  }
}

export class NonceManager {
  private readonly lanes = new Map<string, Lane>();
  private readonly maxQueueDepth: number;

  constructor(opts: NonceManagerOptions = {}) {
    this.maxQueueDepth = opts.maxQueueDepth ?? 32;
  }

  static laneKey(chainId: bigint | number, address: string): string {
    return `${chainId.toString()}:${address.toLowerCase()}`;
  }

  /** Number of operations queued or running for a lane. */
  queueDepth(chainId: bigint | number, address: string): number {
    return this.lanes.get(NonceManager.laneKey(chainId, address))?.depth ?? 0;
  }

  /** Forget local state for a lane (e.g. after a manual intervention). Next run re-reads the chain. */
  reset(chainId: bigint | number, address: string): void {
    const lane = this.lanes.get(NonceManager.laneKey(chainId, address));
    if (lane) lane.nextNonce = undefined;
  }

  /**
   * Run `fn` exclusively for (chainId, address) with an allocated nonce.
   * Calls for the same lane execute in FIFO order; different lanes run in parallel.
   */
  async run<T>(
    chainId: bigint | number,
    address: string,
    source: NonceSource,
    fn: (lease: NonceLease) => Promise<T>,
  ): Promise<T> {
    const key = NonceManager.laneKey(chainId, address);
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), nextNonce: undefined, depth: 0 };
      this.lanes.set(key, lane);
    }
    if (lane.depth >= this.maxQueueDepth) throw new NonceQueueFullError(key, lane.depth);

    const l = lane;
    l.depth++;
    let release!: () => void;
    const prev = l.tail;
    l.tail = new Promise<void>((r) => (release = r));

    try {
      await prev; // prior tails never reject (released in finally)
      const pending = await source.getTransactionCount(address, "pending");
      if (!Number.isSafeInteger(pending) || pending < 0) throw new Error(`Invalid pending nonce ${pending} for ${key}`);
      const nonce = Math.max(pending, l.nextNonce ?? 0);

      const result = await fn({ nonce });
      l.nextNonce = nonce + 1;
      return result;
    } finally {
      l.depth--;
      release();
    }
  }
}
