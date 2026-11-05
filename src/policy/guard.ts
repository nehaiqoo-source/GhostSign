/**
 * Agent policy guardrails. Every check runs BEFORE the NEAR MPC contract is called, so a
 * rejected intent costs no NEAR gas, no deposit, and never produces a signature.
 *
 * Spend accounting uses reservations: `reserve()` checks AND holds the amount in one synchronous
 * step (no await between them), so concurrent intents cannot both squeeze under the daily cap.
 * The caller commits the reservation after broadcast, or releases it if nothing was sent.
 *
 * Caps cover the transferred `value` only; gas is bounded separately by the executor's
 * worst-case balance check.
 */
import { formatEther, getAddress, isAddress, parseEther } from "ethers";
import type { ChainKey } from "../chains/config.js";
import type { Env } from "../config/env.js";
import { ErrorCode, PolicyViolationError } from "../errors.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Addresses that can never receive agent funds, regardless of allowlist. */
export const BURN_ADDRESSES: readonly string[] = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  "0xdead000000000000000042069420694206942069",
];

export interface ChainLimits {
  maxPerTxWei: bigint;
  dailyCapWei: bigint;
}

export interface PolicyConfig extends ChainLimits {
  /** Per-chain overrides of the global limits. */
  perChain?: Partial<Record<ChainKey, Partial<ChainLimits>>>;
  /** Rolling window length for the daily cap. Default 24h. */
  windowMs?: number;
  /** When true, only allowlisted destinations (EOAs or contracts) are permitted. */
  strictMode: boolean;
  allowlist: readonly string[];
  denylist: readonly string[];
  /** Emergency kill switch. */
  frozen: boolean;
}

export interface SpendRequest {
  chain: ChainKey;
  to: string;
  valueWei: bigint;
}

interface LedgerEntry {
  id: number;
  chain: ChainKey;
  amountWei: bigint;
  at: number;
  state: "reserved" | "committed";
}

export interface Reservation {
  readonly id: number;
  readonly chain: ChainKey;
  readonly amountWei: bigint;
  /** The tx was broadcast: the spend counts toward the cap for the full window. */
  commit(): void;
  /** Nothing was broadcast: return the amount to the daily budget. */
  release(): void;
}

export interface PolicyStatus {
  frozen: boolean;
  frozenReason: string | undefined;
  strictMode: boolean;
  chains: Partial<Record<ChainKey, { spentWei: bigint; remainingWei: bigint; maxPerTxWei: bigint; dailyCapWei: bigint }>>;
}

export class PolicyEngine {
  private config: PolicyConfig;
  private readonly allow: Set<string>;
  private readonly deny: Set<string>;
  private readonly ledger: LedgerEntry[] = [];
  private readonly now: () => number;
  private nextId = 1;
  private frozenReason: string | undefined;

  constructor(config: PolicyConfig, opts: { now?: () => number } = {}) {
    if (config.maxPerTxWei < 0n || config.dailyCapWei < 0n) throw new Error("Policy limits must be non-negative");
    this.config = { ...config };
    this.allow = new Set(config.allowlist.map(normalize));
    this.deny = new Set([...config.denylist.map(normalize), ...BURN_ADDRESSES]);
    this.now = opts.now ?? Date.now;
    if (config.frozen) this.frozenReason = "frozen by configuration";
  }

  static fromEnv(env: Env, opts: { now?: () => number } = {}): PolicyEngine {
    return new PolicyEngine(
      {
        maxPerTxWei: parseEther(env.POLICY_MAX_PER_TX_ETH),
        dailyCapWei: parseEther(env.POLICY_DAILY_CAP_ETH),
        strictMode: env.POLICY_STRICT_MODE ?? false,
        allowlist: env.POLICY_ALLOWLIST ?? [],
        denylist: env.POLICY_DENYLIST ?? [],
        frozen: env.GHOSTSIGN_FROZEN ?? false,
      },
      opts,
    );
  }

  // --- Kill switch -------------------------------------------------------------------------

  get isFrozen(): boolean {
    return this.config.frozen;
  }

  freeze(reason = "manual freeze"): void {
    this.config.frozen = true;
    this.frozenReason = reason;
  }

  unfreeze(): void {
    this.config.frozen = false;
    this.frozenReason = undefined;
  }

  // --- Lists -------------------------------------------------------------------------------

  allowDestination(address: string): void {
    this.allow.add(normalize(address));
  }

  denyDestination(address: string): void {
    this.deny.add(normalize(address));
  }

  // --- Checks ------------------------------------------------------------------------------

  limitsFor(chain: ChainKey): ChainLimits {
    const o = this.config.perChain?.[chain];
    return {
      maxPerTxWei: o?.maxPerTxWei ?? this.config.maxPerTxWei,
      dailyCapWei: o?.dailyCapWei ?? this.config.dailyCapWei,
    };
  }

  /** Value (reserved + committed) spent on `chain` inside the rolling window. */
  spentInWindow(chain: ChainKey): bigint {
    this.prune();
    return this.ledger.filter((e) => e.chain === chain).reduce((sum, e) => sum + e.amountWei, 0n);
  }

  /** Throws PolicyViolationError if `req` is not allowed. Does not reserve anything. */
  check(req: SpendRequest): void {
    if (this.config.frozen) {
      throw new PolicyViolationError(ErrorCode.KILL_SWITCH_ACTIVE, `Agent signing is frozen (${this.frozenReason})`);
    }

    if (!isAddress(req.to)) {
      throw new PolicyViolationError(ErrorCode.DESTINATION_NOT_ALLOWED, `Invalid destination address '${req.to}'`);
    }
    const to = normalize(req.to);
    if (this.deny.has(to)) {
      throw new PolicyViolationError(
        ErrorCode.DESTINATION_NOT_ALLOWED,
        `Destination ${getAddress(to)} is a ${BURN_ADDRESSES.includes(to) ? "zero/burn address" : "denylisted address"}`,
        { to: getAddress(to) },
      );
    }
    if (this.config.strictMode && !this.allow.has(to)) {
      throw new PolicyViolationError(
        ErrorCode.DESTINATION_NOT_ALLOWED,
        `Strict mode: destination ${getAddress(to)} is not on the allowlist`,
        { to: getAddress(to) },
      );
    }

    if (req.valueWei < 0n) {
      throw new PolicyViolationError(ErrorCode.SPEND_CAP_EXCEEDED, "Negative value is not allowed");
    }
    const { maxPerTxWei, dailyCapWei } = this.limitsFor(req.chain);
    if (req.valueWei > maxPerTxWei) {
      throw new PolicyViolationError(
        ErrorCode.SPEND_CAP_EXCEEDED,
        `${formatEther(req.valueWei)} ETH exceeds the per-transaction cap of ${formatEther(maxPerTxWei)} ETH on ${req.chain}`,
        { chain: req.chain, requestedWei: req.valueWei.toString(), capWei: maxPerTxWei.toString() },
      );
    }
    const spent = this.spentInWindow(req.chain);
    if (spent + req.valueWei > dailyCapWei) {
      throw new PolicyViolationError(
        ErrorCode.DAILY_CAP_EXCEEDED,
        `${formatEther(req.valueWei)} ETH would exceed the rolling 24h cap on ${req.chain} ` +
          `(${formatEther(spent)} of ${formatEther(dailyCapWei)} ETH already used)`,
        { chain: req.chain, spentWei: spent.toString(), capWei: dailyCapWei.toString() },
      );
    }
  }

  /** Atomically check `req` and hold its value against the rolling cap. */
  reserve(req: SpendRequest): Reservation {
    this.check(req);
    const entry: LedgerEntry = {
      id: this.nextId++,
      chain: req.chain,
      amountWei: req.valueWei,
      at: this.now(),
      state: "reserved",
    };
    this.ledger.push(entry);
    let settled = false;
    return {
      id: entry.id,
      chain: entry.chain,
      amountWei: entry.amountWei,
      commit: () => {
        if (settled) return;
        settled = true;
        entry.state = "committed";
        entry.at = this.now(); // window starts at broadcast time
      },
      release: () => {
        if (settled) return;
        settled = true;
        const i = this.ledger.indexOf(entry);
        if (i >= 0) this.ledger.splice(i, 1);
      },
    };
  }

  status(chains: readonly ChainKey[]): PolicyStatus {
    const out: PolicyStatus["chains"] = {};
    for (const c of chains) {
      const { maxPerTxWei, dailyCapWei } = this.limitsFor(c);
      const spentWei = this.spentInWindow(c);
      out[c] = { spentWei, remainingWei: dailyCapWei > spentWei ? dailyCapWei - spentWei : 0n, maxPerTxWei, dailyCapWei };
    }
    return { frozen: this.config.frozen, frozenReason: this.frozenReason, strictMode: this.config.strictMode, chains: out };
  }

  private prune(): void {
    const cutoff = this.now() - (this.config.windowMs ?? DAY_MS);
    for (let i = this.ledger.length - 1; i >= 0; i--) {
      const e = this.ledger[i]!;
      // Only committed spends age out; an open reservation is still in flight.
      if (e.state === "committed" && e.at <= cutoff) this.ledger.splice(i, 1);
    }
  }
}

function normalize(address: string): string {
  return address.trim().toLowerCase();
}
