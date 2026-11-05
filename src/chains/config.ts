import type { Env } from "../config/env.js";
import { ErrorCode, GhostSignError } from "../errors.js";

export const SUPPORTED_CHAINS = ["ethereum-sepolia", "base-sepolia"] as const;
export type ChainKey = (typeof SUPPORTED_CHAINS)[number];

export interface EvmChainConfig {
  key: ChainKey;
  name: string;
  chainId: bigint;
  currency: string;
  explorerUrl: string;
  rpcUrl: string;
  /**
   * OP-Stack chains (Base) charge an L1 data fee on top of L2 gas. It is not part of
   * gasLimit × maxFeePerGas, so the pre-flight balance check adds this wei headroom.
   */
  l1DataFeeBufferWei: bigint;
}

type StaticChainConfig = Omit<EvmChainConfig, "rpcUrl"> & { rpcEnvVar: "ETHEREUM_SEPOLIA_RPC" | "BASE_SEPOLIA_RPC" };

const CHAINS: Readonly<Record<ChainKey, StaticChainConfig>> = {
  "ethereum-sepolia": {
    key: "ethereum-sepolia",
    name: "Ethereum Sepolia",
    chainId: 11155111n,
    currency: "ETH",
    explorerUrl: "https://sepolia.etherscan.io",
    rpcEnvVar: "ETHEREUM_SEPOLIA_RPC",
    l1DataFeeBufferWei: 0n,
  },
  "base-sepolia": {
    key: "base-sepolia",
    name: "Base Sepolia",
    chainId: 84532n,
    currency: "ETH",
    explorerUrl: "https://sepolia.basescan.org",
    rpcEnvVar: "BASE_SEPOLIA_RPC",
    l1DataFeeBufferWei: 10_000_000_000_000n, // 0.00001 ETH: generous for a plain transfer
  },
};

export function isChainKey(value: string): value is ChainKey {
  return (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

export function getChainConfig(key: string, env: Env): EvmChainConfig {
  if (!isChainKey(key)) {
    throw new GhostSignError(ErrorCode.UNSUPPORTED_CHAIN, `Unsupported chain '${key}'`, {
      supported: SUPPORTED_CHAINS,
    });
  }
  const { rpcEnvVar, ...rest } = CHAINS[key];
  return { ...rest, rpcUrl: env[rpcEnvVar] };
}

export function txExplorerUrl(chain: Pick<EvmChainConfig, "explorerUrl">, txHash: string): string {
  return `${chain.explorerUrl}/tx/${txHash}`;
}
