/**
 * Intent gateway: the single entry point an autonomous agent uses to move funds.
 *
 *   validate → policy (reserve) → derive + balance → nonce queue → NEAR MPC sign → broadcast
 *
 * Policy and balance checks run before anything touches the MPC contract. The gateway never
 * throws for expected failures; it returns a typed `{ success: false, code }` result so an LLM
 * agent can reason about the outcome.
 */
import { formatEther, getAddress, isAddress, parseEther } from "ethers";
import { z } from "zod";
import { SUPPORTED_CHAINS, getChainConfig, type ChainKey } from "../chains/config.js";
import { EvmExecutor, type EvmExecutorLike } from "../chains/evmExecutor.js";
import { loadEnv, type Env } from "../config/env.js";
import { ErrorCode, GhostSignError, type ErrorCode as ErrorCodeT } from "../errors.js";
import { PolicyEngine, type Reservation } from "../policy/guard.js";
import { MpcSigner } from "../services/mpcSigner.js";
import { NonceManager, NonceQueueFullError } from "../services/nonceManager.js";

export const DEFAULT_DERIVATION_PATH = "ethereum-1";

const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;

export const IntentSchema = z
  .object({
    chain: z.enum(SUPPORTED_CHAINS),
    to: z.string().refine((v) => isAddress(v), "must be a valid 0x EVM address"),
    /** Decimal amount in the chain's native currency (ETH), e.g. "0.001". */
    amount: z
      .string()
      .regex(AMOUNT_RE, "must be a decimal string with at most 18 decimals")
      // zod v4 still runs refinements after a failed regex, so guard before parsing.
      .refine((v) => !AMOUNT_RE.test(v) || parseEther(v) > 0n, "must be greater than zero"),
    /** Why the agent wants to do this. Required for the audit trail. */
    reason: z.string().trim().min(3).max(500),
    derivationPath: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._\-/:]+$/, "may contain only letters, digits and . _ - / :")
      .optional(),
  })
  .strict();

export type AgentIntent = z.infer<typeof IntentSchema>;

/** JSON Schema for the intent, ready to expose as an LLM tool definition. */
export const intentJsonSchema = () => z.toJSONSchema(IntentSchema);

export interface IntentSuccess {
  success: true;
  chain: ChainKey;
  txHash: string;
  explorerUrl: string;
  executionTimeMs: number;
  from: `0x${string}`;
  to: `0x${string}`;
  amount: string;
  nonce: number;
  nearTxHash: string;
}

export interface IntentFailure {
  success: false;
  chain: ChainKey | undefined;
  code: ErrorCodeT;
  error: string;
  /** True if the MPC contract was never called (no NEAR gas/deposit spent). */
  rejectedBeforeSigning: boolean;
  executionTimeMs: number;
  details?: Readonly<Record<string, unknown>>;
}

export type IntentResult = IntentSuccess | IntentFailure;

export type GatewayEvent =
  | { type: "intent.received"; intent: AgentIntent }
  | { type: "intent.rejected"; intent: unknown; code: ErrorCodeT; error: string }
  | { type: "intent.signing"; intent: AgentIntent; from: string }
  | { type: "intent.executed"; intent: AgentIntent; result: IntentSuccess };

export interface IntentGatewayOptions {
  policy: PolicyEngine;
  executors: Partial<Record<ChainKey, EvmExecutorLike>>;
  defaultDerivationPath?: string;
  onEvent?: (event: GatewayEvent) => void;
}

/** Codes that are raised before the MPC contract is invoked. */
const PRE_SIGNING_CODES: ReadonlySet<ErrorCodeT> = new Set([
  ErrorCode.INVALID_INTENT,
  ErrorCode.UNSUPPORTED_CHAIN,
  ErrorCode.KILL_SWITCH_ACTIVE,
  ErrorCode.SPEND_CAP_EXCEEDED,
  ErrorCode.DAILY_CAP_EXCEEDED,
  ErrorCode.DESTINATION_NOT_ALLOWED,
  ErrorCode.INSUFFICIENT_FUNDS,
  ErrorCode.CHAIN_MISMATCH,
  ErrorCode.QUEUE_FULL,
]);

export class IntentGateway {
  readonly policy: PolicyEngine;
  private readonly executors: Partial<Record<ChainKey, EvmExecutorLike>>;
  private readonly defaultPath: string;
  private readonly onEvent: ((event: GatewayEvent) => void) | undefined;

  constructor(opts: IntentGatewayOptions) {
    this.policy = opts.policy;
    this.executors = opts.executors;
    this.defaultPath = opts.defaultDerivationPath ?? DEFAULT_DERIVATION_PATH;
    this.onEvent = opts.onEvent;
  }

  /** Wire real executors for every supported chain from the environment. */
  static fromEnv(opts: { env?: Env; onEvent?: (e: GatewayEvent) => void; policy?: PolicyEngine } = {}): IntentGateway {
    const env = opts.env ?? loadEnv();
    const signer = new MpcSigner({ env });
    const nonceManager = new NonceManager();
    const executors: Partial<Record<ChainKey, EvmExecutorLike>> = {};
    for (const key of SUPPORTED_CHAINS) {
      executors[key] = new EvmExecutor({
        chain: getChainConfig(key, env),
        signer,
        rootPublicKey: env.MPC_ROOT_PUBLIC_KEY,
        nonceManager,
      });
    }
    return new IntentGateway({
      policy: opts.policy ?? PolicyEngine.fromEnv(env),
      executors,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    });
  }

  /** The agent's address for a path. Identical on every EVM chain. */
  addressFor(chain: ChainKey, derivationPath = this.defaultPath): `0x${string}` {
    return this.executorFor(chain).addressFor(derivationPath);
  }

  async execute(rawIntent: unknown): Promise<IntentResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);

    // 1. Validate
    const parsed = IntentSchema.safeParse(rawIntent);
    if (!parsed.success) {
      const error = parsed.error.issues.map((i) => `${i.path.join(".") || "intent"}: ${i.message}`).join("; ");
      return this.fail(rawIntent, undefined, new GhostSignError(ErrorCode.INVALID_INTENT, error), elapsed());
    }
    const intent = parsed.data;
    this.emit({ type: "intent.received", intent });
    const path = intent.derivationPath ?? this.defaultPath;
    const valueWei = parseEther(intent.amount);

    let reservation: Reservation | undefined;
    try {
      const executor = this.executorFor(intent.chain);

      // 2. Policy — atomically checks and reserves against the rolling cap.
      reservation = this.policy.reserve({ chain: intent.chain, to: intent.to, valueWei });

      // 3. Derive foreign address + quick balance pre-check (executor re-checks incl. gas).
      const from = executor.addressFor(path);
      const balance = await executor.getBalance(from);
      if (balance < valueWei) {
        throw new GhostSignError(
          ErrorCode.INSUFFICIENT_FUNDS,
          `${from} holds ${formatEther(balance)} ${executor.chain.currency} on ${executor.chain.name}, needs ${intent.amount} plus gas`,
          { chain: intent.chain, address: from, balance: balance.toString() },
        );
      }

      // 4–6. Nonce queue → MPC signature → broadcast.
      this.emit({ type: "intent.signing", intent, from });
      const sent = await executor.send(path, { to: intent.to, value: valueWei });
      reservation.commit();

      // 7. Result
      const result: IntentSuccess = {
        success: true,
        chain: intent.chain,
        txHash: sent.txHash,
        explorerUrl: sent.explorerUrl,
        executionTimeMs: elapsed(),
        from: sent.from,
        to: getAddress(intent.to) as `0x${string}`,
        amount: intent.amount,
        nonce: sent.nonce,
        nearTxHash: sent.nearTxHash,
      };
      this.emit({ type: "intent.executed", intent, result });
      return result;
    } catch (err) {
      // A failed broadcast may still have reached the mempool: keep the spend counted.
      if (reservation) {
        if (err instanceof GhostSignError && err.code === ErrorCode.BROADCAST_FAILED) reservation.commit();
        else reservation.release();
      }
      return this.fail(intent, intent.chain, err, elapsed());
    }
  }

  private executorFor(chain: ChainKey): EvmExecutorLike {
    const ex = this.executors[chain];
    if (!ex) throw new GhostSignError(ErrorCode.UNSUPPORTED_CHAIN, `No executor configured for ${chain}`);
    return ex;
  }

  private fail(intent: unknown, chain: ChainKey | undefined, err: unknown, executionTimeMs: number): IntentFailure {
    const gs =
      err instanceof GhostSignError
        ? err
        : err instanceof NonceQueueFullError
          ? new GhostSignError(ErrorCode.QUEUE_FULL, err.message)
          : new GhostSignError(ErrorCode.EXECUTION_FAILED, err instanceof Error ? err.message : String(err));
    this.emit({ type: "intent.rejected", intent, code: gs.code, error: gs.message });
    return {
      success: false,
      chain,
      code: gs.code,
      error: gs.message,
      rejectedBeforeSigning: PRE_SIGNING_CODES.has(gs.code),
      executionTimeMs,
      ...(gs.details ? { details: gs.details } : {}),
    };
  }

  private emit(event: GatewayEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // observers must never break execution
    }
  }
}
