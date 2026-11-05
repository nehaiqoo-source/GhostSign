/**
 * Phase 1 compatibility layer. New code should use `EvmExecutor` (chains/evmExecutor.ts) or the
 * intent gateway; this keeps the original Sepolia-only API working on top of it.
 */
import { loadEnv, type Env } from "../config/env.js";
import { MpcSigner } from "../services/mpcSigner.js";
import { NonceManager } from "../services/nonceManager.js";
import { getChainConfig } from "./config.js";
import { EvmExecutor, type EvmSendResult, type EvmTxRequest } from "./evmExecutor.js";

export { reconstructEvmSignature, type ReconstructedSignature } from "./evmSignature.js";
export type { EvmSendResult, EvmTxRequest } from "./evmExecutor.js";

export const SEPOLIA_CHAIN_ID = 11155111n;
export const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";

export interface EthereumAgentOptions {
  env?: Env;
  signer?: MpcSigner;
  nonceManager?: NonceManager;
}

/** Ethereum Sepolia executor bound to the env-configured MPC signer. */
export class EthereumAgent extends EvmExecutor {
  readonly mpcSigner: MpcSigner;

  constructor(opts: EthereumAgentOptions = {}) {
    const env = opts.env ?? loadEnv();
    const signer = opts.signer ?? new MpcSigner({ env });
    super({
      chain: getChainConfig("ethereum-sepolia", env),
      signer,
      rootPublicKey: env.MPC_ROOT_PUBLIC_KEY,
      nonceManager: opts.nonceManager ?? new NonceManager(),
    });
    this.mpcSigner = signer;
  }

  /** @deprecated use `send` */
  sendTransaction(derivationPath: string, req: EvmTxRequest): Promise<EvmSendResult> {
    return this.send(derivationPath, req);
  }
}

export async function signAndSendSepoliaTransaction(derivationPath: string, req: EvmTxRequest): Promise<EvmSendResult> {
  return new EthereumAgent().send(derivationPath, req);
}
