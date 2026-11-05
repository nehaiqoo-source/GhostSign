/**
 * Multi-chain EVM executor. One instance per chain; all instances share the same MPC signer,
 * so (NEAR account, derivation path) maps to the SAME address on every EVM chain — the derived
 * secp256k1 key is chain-independent and replay protection comes from the EIP-155 chainId in
 * the signed digest.
 */
import { JsonRpcProvider, Signature, Transaction, getAddress, getBytes, isAddress, type BigNumberish } from "ethers";
import { deriveChildPublicKey } from "../crypto/kdf.js";
import { ErrorCode, GhostSignError } from "../errors.js";
import type { MpcSignature } from "../services/mpcSigner.js";
import { NonceManager } from "../services/nonceManager.js";
import { txExplorerUrl, type ChainKey, type EvmChainConfig } from "./config.js";
import { reconstructEvmSignature } from "./evmSignature.js";

/** The subset of MpcSigner the executor needs (lets tests inject a fake MPC network). */
export interface MpcSignerLike {
  readonly accountId: string;
  requestMpcSignature(payload32Bytes: Uint8Array, derivationPath: string): Promise<MpcSignature>;
}

export interface EvmTxRequest {
  to: string;
  /** wei */
  value?: BigNumberish;
  data?: string;
  gasLimit?: BigNumberish;
  maxFeePerGas?: BigNumberish;
  maxPriorityFeePerGas?: BigNumberish;
}

export interface EvmSendResult {
  chain: ChainKey;
  from: `0x${string}`;
  to: `0x${string}`;
  nonce: number;
  txHash: string;
  explorerUrl: string;
  nearTxHash: string;
  rawTransaction: string;
}

/** Progress callbacks fired from inside the serialized critical section. */
export interface SendHooks {
  /** Lane acquired and nonce allocated. */
  onNonce?(nonce: number): void;
  /** Unsigned tx built; NEAR MPC `sign` is being called. */
  onSigning?(digest: string): void;
  /** MPC signature received and verified. */
  onSigned?(nearTxHash: string): void;
}

export interface Confirmation {
  status: "success" | "reverted";
  blockNumber: number;
}

/** What the intent gateway needs from an executor. */
export interface EvmExecutorLike {
  readonly chain: EvmChainConfig;
  addressFor(derivationPath: string): `0x${string}`;
  getBalance(address: string): Promise<bigint>;
  send(derivationPath: string, req: EvmTxRequest, hooks?: SendHooks): Promise<EvmSendResult>;
  waitForConfirmation?(txHash: string, timeoutMs?: number): Promise<Confirmation>;
}

export interface EvmExecutorOptions {
  chain: EvmChainConfig;
  signer: MpcSignerLike;
  rootPublicKey: string;
  nonceManager: NonceManager;
  provider?: JsonRpcProvider;
  /** Percentage added to eth_estimateGas. Default 20. */
  gasHeadroomPct?: bigint;
}

const DEFAULT_PRIORITY_FEE = 1_500_000_000n; // 1.5 gwei fallback for RPCs without eth_maxPriorityFeePerGas

export class EvmExecutor implements EvmExecutorLike {
  readonly chain: EvmChainConfig;
  readonly provider: JsonRpcProvider;
  private readonly signer: MpcSignerLike;
  private readonly rootPublicKey: string;
  private readonly nonces: NonceManager;
  private readonly gasHeadroomPct: bigint;
  private chainVerified = false;
  private readonly addressCache = new Map<string, `0x${string}`>();

  constructor(opts: EvmExecutorOptions) {
    this.chain = opts.chain;
    this.signer = opts.signer;
    this.rootPublicKey = opts.rootPublicKey;
    this.nonces = opts.nonceManager;
    this.gasHeadroomPct = opts.gasHeadroomPct ?? 20n;
    this.provider =
      opts.provider ?? new JsonRpcProvider(opts.chain.rpcUrl, Number(opts.chain.chainId), { staticNetwork: true });
  }

  addressFor(derivationPath: string): `0x${string}` {
    let addr = this.addressCache.get(derivationPath);
    if (!addr) {
      addr = deriveChildPublicKey(this.rootPublicKey, this.signer.accountId, derivationPath).ethereumAddress;
      this.addressCache.set(derivationPath, addr);
    }
    return addr;
  }

  getBalance(address: string): Promise<bigint> {
    return this.provider.getBalance(address);
  }

  /** Serialize via the nonce queue, MPC-sign, broadcast. */
  async send(derivationPath: string, req: EvmTxRequest, hooks: SendHooks = {}): Promise<EvmSendResult> {
    if (!isAddress(req.to)) {
      throw new GhostSignError(ErrorCode.INVALID_INTENT, `Invalid destination address: ${req.to}`);
    }
    await this.assertChain();
    const from = this.addressFor(derivationPath);

    return this.nonces.run(this.chain.chainId, from, this.provider, async ({ nonce }) => {
      safe(() => hooks.onNonce?.(nonce));
      const tx = await this.buildUnsigned(from, req, nonce);
      const digest = tx.unsignedHash;
      safe(() => hooks.onSigning?.(digest));

      let mpc: MpcSignature;
      try {
        mpc = await this.signer.requestMpcSignature(getBytes(digest), derivationPath);
      } catch (err) {
        throw new GhostSignError(ErrorCode.MPC_SIGNING_FAILED, `MPC signing failed: ${errMsg(err)}`, {}, { cause: err });
      }

      try {
        tx.signature = Signature.from(reconstructEvmSignature(digest, mpc, from));
      } catch (err) {
        throw new GhostSignError(ErrorCode.SIGNATURE_MISMATCH, errMsg(err), { nearTxHash: mpc.nearTxHash }, { cause: err });
      }
      if (tx.from !== from) {
        throw new GhostSignError(ErrorCode.SIGNATURE_MISMATCH, `Signed sender ${tx.from} ≠ derived ${from}`);
      }
      safe(() => hooks.onSigned?.(mpc.nearTxHash));

      const rawTransaction = tx.serialized;
      let txHash: string;
      try {
        txHash = (await this.provider.broadcastTransaction(rawTransaction)).hash;
      } catch (err) {
        throw new GhostSignError(
          ErrorCode.BROADCAST_FAILED,
          `Broadcast to ${this.chain.name} failed: ${errMsg(err)}`,
          { nonce, nearTxHash: mpc.nearTxHash, rawTransaction },
          { cause: err },
        );
      }

      return {
        chain: this.chain.key,
        from,
        to: getAddress(req.to) as `0x${string}`,
        nonce,
        txHash,
        explorerUrl: txExplorerUrl(this.chain, txHash),
        nearTxHash: mpc.nearTxHash,
        rawTransaction,
      };
    });
  }

  /** Wait for one confirmation. Throws on timeout. */
  async waitForConfirmation(txHash: string, timeoutMs = 180_000): Promise<Confirmation> {
    const receipt = await this.provider.waitForTransaction(txHash, 1, timeoutMs);
    if (!receipt) throw new Error(`No receipt for ${txHash}`);
    return { status: receipt.status === 1 ? "success" : "reverted", blockNumber: receipt.blockNumber };
  }

  private async assertChain(): Promise<void> {
    if (this.chainVerified) return;
    const id = BigInt(await this.provider.send("eth_chainId", []));
    if (id !== this.chain.chainId) {
      throw new GhostSignError(
        ErrorCode.CHAIN_MISMATCH,
        `RPC ${this.chain.rpcUrl} is on chain ${id}, expected ${this.chain.chainId} (${this.chain.name})`,
      );
    }
    this.chainVerified = true;
  }

  private async buildUnsigned(from: string, req: EvmTxRequest, nonce: number): Promise<Transaction> {
    const to = getAddress(req.to);
    const value = BigInt(req.value ?? 0);
    if (value < 0n) throw new GhostSignError(ErrorCode.INVALID_INTENT, "value must be non-negative");
    const data = req.data ?? "0x";

    const needFees = req.maxFeePerGas === undefined || req.maxPriorityFeePerGas === undefined;
    const [feeData, balance, estimated] = await Promise.all([
      needFees ? this.provider.getFeeData() : Promise.resolve(undefined),
      this.provider.getBalance(from),
      req.gasLimit === undefined ? this.provider.estimateGas({ from, to, value, data }) : Promise.resolve(undefined),
    ]);

    const maxPriorityFeePerGas = BigInt(req.maxPriorityFeePerGas ?? feeData?.maxPriorityFeePerGas ?? DEFAULT_PRIORITY_FEE);
    const maxFeePerGas = BigInt(
      req.maxFeePerGas ?? feeData?.maxFeePerGas ?? (feeData?.gasPrice ?? 0n) * 2n + maxPriorityFeePerGas,
    );
    if (maxFeePerGas < maxPriorityFeePerGas) {
      throw new GhostSignError(ErrorCode.INVALID_INTENT, "maxFeePerGas < maxPriorityFeePerGas");
    }
    const gasLimit = req.gasLimit !== undefined ? BigInt(req.gasLimit) : (estimated! * (100n + this.gasHeadroomPct)) / 100n;

    const worstCase = value + gasLimit * maxFeePerGas + this.chain.l1DataFeeBufferWei;
    if (balance < worstCase) {
      throw new GhostSignError(
        ErrorCode.INSUFFICIENT_FUNDS,
        `Insufficient ${this.chain.currency} on ${this.chain.name} for ${from}: balance ${balance} wei < worst-case ${worstCase} wei`,
        { chain: this.chain.key, address: from, balance: balance.toString(), required: worstCase.toString() },
      );
    }

    return Transaction.from({
      type: 2,
      chainId: this.chain.chainId,
      nonce,
      to,
      value,
      data,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
  }
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // progress observers must never break signing
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    const short = (err as { shortMessage?: unknown }).shortMessage;
    return typeof short === "string" ? short : err.message;
  }
  return String(err);
}
