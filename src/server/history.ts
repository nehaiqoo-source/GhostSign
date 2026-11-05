/**
 * Transactions confirmed on-chain during CLI testing (scripts/demo-agent.ts, `send`).
 * Shown in the dashboard feed as verifiable history when the server runs as the same agent.
 */
import type { ChainKey } from "../chains/config.js";

export interface ProvenTx {
  chain: ChainKey;
  txHash: string;
  nearTxHash: string;
  nonce: number;
  blockNumber: number;
  amount: string;
  reason: string;
}

export const PROOF_AGENT_ACCOUNT = "ghostsign-mw3bniwz.testnet";
export const PROOF_AGENT_ADDRESS = "0xE2949d91b0db27636f20FBD79217cB3f5325d212";

export const PROVEN_TXS: readonly ProvenTx[] = [
  {
    chain: "ethereum-sepolia",
    txHash: "0x1710b3ae7c9e8932134d86a8bae3cef35c81942e67e8dc07ddf69a5121a6cd13",
    nearTxHash: "BBQy2MAfjyTHUXFNJyVxfeznTpZ9rhC6Mdxqvh9V6zbh",
    nonce: 0,
    blockNumber: 12068534,
    amount: "0.0001",
    reason: "Phase 1: first keyless MPC-signed transfer",
  },
  {
    chain: "ethereum-sepolia",
    txHash: "0x132b61c3b7ff71e3d8819c9a8e97dc2184ffef811afefebdd3a95df856a1e5fd",
    nearTxHash: "DFNzHtr21UppAVq6k6bAZF3UgAF5m3fgP6nBSxviQNgv",
    nonce: 1,
    blockNumber: 12068755,
    amount: "0.0001",
    reason: "Phase 2 demo: intent gateway on Ethereum Sepolia",
  },
  {
    chain: "ethereum-sepolia",
    txHash: "0xfe2b5509800b7cc9071fe6af4b1ae9c8b87d8d1c6d003ffa0c1cc713e8945f84",
    nearTxHash: "J5zQXfwq1LBqGHgs4CMUPFz5LUVUtfYpdHTEFuDz35JM",
    nonce: 2,
    blockNumber: 12068757,
    amount: "0.00001",
    reason: "Phase 2 demo: concurrent intent #1 (nonce queue)",
  },
  {
    chain: "ethereum-sepolia",
    txHash: "0x057de6fa382f66cea999f3864c3587e0cf75c0ee71b8d0d3bc5f5bfb1f012e18",
    nearTxHash: "7CdaSTowdUtd14zubkjb4KE4kw43QFkUsUBjzZCKsum7",
    nonce: 3,
    blockNumber: 12068760,
    amount: "0.00001",
    reason: "Phase 2 demo: concurrent intent #2 (nonce queue)",
  },
  {
    chain: "ethereum-sepolia",
    txHash: "0x1f844c3805edbc579142bc15a2a16a4dd5dfa9723d3d19d14298189824b274d8",
    nearTxHash: "G8UkmnJCcE2MzYp8w89tQEJkLgYkrGaW2xMW7xtn6ErP",
    nonce: 4,
    blockNumber: 12068773,
    amount: "0.0001",
    reason: "Phase 2 demo: multi-chain run (Ethereum leg)",
  },
  {
    chain: "base-sepolia",
    txHash: "0x7b66639baf6cba0564ffecc18fbe2f5d87f4c4d1d79e0ffeaacd1cd7cfa43de0",
    nearTxHash: "h7KR9H7kaHtb9B7XXDrFbuJHchB6TpTeHNMZBeQVCFy",
    nonce: 0,
    blockNumber: 54756585,
    amount: "0.0001",
    reason: "Phase 2 demo: multi-chain run (Base leg, same address)",
  },
  {
    chain: "ethereum-sepolia",
    txHash: "0x4d76d88fcb067e1007fe653523cec571a7690f3bbb1f8721212d29d7d6841afd",
    nearTxHash: "Hfz1yAGJm8cVxzttr8NHBBrk6sHFBZ1whiTm9tTjufi4",
    nonce: 5,
    blockNumber: 12068825,
    amount: "0.0005",
    reason: "Dashboard: multi-chain burst (Ethereum leg)",
  },
  {
    chain: "base-sepolia",
    txHash: "0xc500543a114d2059be7b916a36664a8936f6061f5e27e08bd8bcbc80fa41314c",
    nearTxHash: "Bkd1xej6SbReP9Xzepr55LQtAQDDPoawLm74XfY6j2dj",
    nonce: 1,
    blockNumber: 54759674,
    amount: "0.0005",
    reason: "Dashboard: multi-chain burst (Base leg, in parallel)",
  },
];
