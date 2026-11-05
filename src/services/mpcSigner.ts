/**
 * Client for the NEAR Chain Signatures MPC contract (`v1.signer-prod.testnet` / `v1.signer`).
 *
 * `sign` is implemented with NEAR's yield/resume: the transaction stays pending until the MPC
 * nodes finish a signing round (typically 5–30 s), which can outlast a single RPC wait. We
 * therefore sign the NEAR transaction ourselves, keep its hash, and poll for the final
 * outcome if the RPC call times out — so a slow MPC round never loses a paid-for signature.
 */
import { createHash } from "node:crypto";
import bs58 from "bs58";
import {
  Account,
  JsonRpcProvider,
  KeyPairSigner,
  actions,
  getTransactionLastResult,
  nearToYocto,
  teraToGas,
  type KeyPairString,
  type TxExecutionStatus,
} from "near-api-js";
import { z } from "zod";
import { loadEnv, requireEnv, type Env } from "../config/env.js";

/** Maximum gas a single NEAR transaction may attach; the MPC round needs all of it. */
export const MPC_SIGN_GAS = teraToGas(300); // 300_000_000_000_000
/** Lower bound guard: the contract rejects zero deposit and fees are dynamic under load. */
export const MIN_SIGN_DEPOSIT_YOCTO = 1n;

const SignatureResponseSchema = z.object({
  scheme: z.string().optional(),
  big_r: z.object({ affine_point: z.string().regex(/^0[23][0-9a-fA-F]{64}$/, "big_r must be a compressed point") }),
  s: z.object({ scalar: z.string().regex(/^[0-9a-fA-F]{1,64}$/, "s must be a 32-byte hex scalar") }),
  recovery_id: z.number().int().min(0).max(3),
});

/** Raw signature as returned by the MPC contract. */
export type MpcSignatureResponse = z.infer<typeof SignatureResponseSchema>;

export interface MpcSignature {
  /** Compressed SEC1 R point (33 bytes, hex, no 0x). r = R.x mod n. */
  bigR: string;
  /** s scalar, 32-byte zero-padded hex, no 0x. Not normalised — see chains/ethereum.ts. */
  s: string;
  /** Recovery id reported by the contract (0–3). Re-derived and verified by callers. */
  recoveryId: number;
  /** NEAR transaction that produced the signature (base58). */
  nearTxHash: string;
}

export interface MpcSignerOptions {
  env?: Env;
  /** Override the per-call deposit (yoctoNEAR). Defaults to MPC_SIGN_DEPOSIT_NEAR. */
  depositYocto?: bigint;
  /** How long to keep polling for the MPC result after an RPC timeout. Default 120 s. */
  resultTimeoutMs?: number;
  /** Poll interval while waiting for the MPC result. Default 2 s. */
  pollIntervalMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /timeout/i.test(err.name) || /timeout|timed out|TIMEOUT_ERROR/i.test(err.message);
}

function failureMessage(status: unknown): string | undefined {
  if (status && typeof status === "object" && "Failure" in status) {
    return JSON.stringify((status as { Failure: unknown }).Failure);
  }
  return undefined;
}

export class MpcSigner {
  readonly env: Env;
  readonly provider: JsonRpcProvider;
  readonly account: Account;
  readonly contractId: string;
  readonly depositYocto: bigint;
  private readonly resultTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(opts: MpcSignerOptions = {}) {
    this.env = opts.env ?? loadEnv();
    const accountId = requireEnv(this.env, "NEAR_ACCOUNT_ID");
    const privateKey = requireEnv(this.env, "NEAR_PRIVATE_KEY") as KeyPairString;

    this.provider = new JsonRpcProvider({ url: this.env.NEAR_NODE_URL });
    this.account = new Account(accountId, this.provider, KeyPairSigner.fromSecretKey(privateKey));
    this.contractId = this.env.MPC_CONTRACT_ID;
    this.depositYocto = opts.depositYocto ?? nearToYocto(this.env.MPC_SIGN_DEPOSIT_NEAR as `${number}`);
    if (this.depositYocto < MIN_SIGN_DEPOSIT_YOCTO) throw new Error("MPC sign deposit must be at least 1 yoctoNEAR");
    this.resultTimeoutMs = opts.resultTimeoutMs ?? 120_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  }

  /** The NEAR account whose id is the KDF `predecessor` for every derived foreign key. */
  get accountId(): string {
    return this.account.accountId;
  }

  /** Root public key as published on-chain (use to verify MPC_ROOT_PUBLIC_KEY). */
  async fetchRootPublicKey(): Promise<string> {
    return z.string().parse(
      await this.provider.callFunction({ contractId: this.contractId, method: "public_key", args: {} }),
    );
  }

  /** Contract-side derivation for cross-checking the local KDF. */
  async fetchDerivedPublicKey(path: string, predecessor = this.accountId): Promise<string> {
    return z.string().parse(
      await this.provider.callFunction({
        contractId: this.contractId,
        method: "derived_public_key",
        args: { path, predecessor },
      }),
    );
  }

  /**
   * Ask the MPC network to sign a 32-byte digest with the key derived for (this account, path).
   * Blocks until the signature is available or `resultTimeoutMs` elapses.
   */
  async requestMpcSignature(payload32Bytes: Uint8Array, derivationPath: string): Promise<MpcSignature> {
    if (!(payload32Bytes instanceof Uint8Array) || payload32Bytes.length !== 32) {
      throw new Error(`MPC payload must be exactly 32 bytes, got ${payload32Bytes?.length ?? "non-bytes"}`);
    }
    if (payload32Bytes.every((b) => b === 0)) throw new Error("Refusing to sign an all-zero payload");
    if (!derivationPath) throw new Error("derivationPath is required");

    const args = {
      request: {
        payload: Array.from(payload32Bytes),
        path: derivationPath,
        key_version: 0,
      },
    };

    const signedTx = await this.account.createSignedTransaction({
      receiverId: this.contractId,
      actions: [actions.functionCall("sign", args, MPC_SIGN_GAS, this.depositYocto)],
    });
    const nearTxHash = bs58.encode(createHash("sha256").update(signedTx.transaction.encode()).digest());

    const waitUntil: TxExecutionStatus = "EXECUTED_OPTIMISTIC";
    let outcome: Awaited<ReturnType<JsonRpcProvider["sendTransactionUntil"]>>;
    try {
      outcome = await this.provider.sendTransactionUntil(signedTx, waitUntil);
    } catch (err) {
      if (!isTimeoutError(err)) throw err;
      outcome = await this.waitForOutcome(nearTxHash, waitUntil);
    }

    const failure = failureMessage(outcome.status);
    if (failure) throw new Error(`MPC sign transaction ${nearTxHash} failed: ${failure}`);

    const parsed = SignatureResponseSchema.safeParse(getTransactionLastResult(outcome));
    if (!parsed.success) {
      throw new Error(`Unexpected MPC sign response for ${nearTxHash}: ${parsed.error.message}`);
    }
    return {
      bigR: parsed.data.big_r.affine_point.toLowerCase(),
      s: parsed.data.s.scalar.toLowerCase().padStart(64, "0"),
      recoveryId: parsed.data.recovery_id,
      nearTxHash,
    };
  }

  private async waitForOutcome(txHash: string, waitUntil: TxExecutionStatus) {
    const deadline = Date.now() + this.resultTimeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await this.provider.viewTransactionStatus({ txHash, accountId: this.accountId, waitUntil });
        const st = res.status;
        // A still-pending tx reports status "Started"/"NotStarted" (string) — keep polling.
        if (st && typeof st === "object" && ("SuccessValue" in st || "Failure" in st)) return res;
      } catch (err) {
        lastErr = err; // UNKNOWN_TRANSACTION / timeouts while the tx propagates
      }
      await sleep(this.pollIntervalMs);
    }
    throw new Error(
      `Timed out after ${this.resultTimeoutMs} ms waiting for MPC signature (NEAR tx ${txHash}). ` +
        `The signature may still land; inspect the tx before retrying.` +
        (lastErr instanceof Error ? ` Last error: ${lastErr.message}` : ""),
    );
  }
}

let defaultSigner: MpcSigner | undefined;

/** Functional entry point using a lazily-created signer configured from the environment. */
export async function requestMpcSignature(payload32Bytes: Uint8Array, derivationPath: string): Promise<MpcSignature> {
  defaultSigner ??= new MpcSigner();
  return defaultSigner.requestMpcSignature(payload32Bytes, derivationPath);
}
