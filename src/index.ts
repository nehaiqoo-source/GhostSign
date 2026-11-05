#!/usr/bin/env node
/**
 * GhostSign CLI (Phase 1)
 *
 *   npm run dev -- address [path]                  derive the agent's EVM address
 *   npm run dev -- verify  [path]                  cross-check root key + KDF against the MPC contract
 *   npm run dev -- send <path> <to> <eth> [data]   sign via NEAR MPC and broadcast on Sepolia
 */
import { JsonRpcProvider } from "near-api-js";
import { formatEther, parseEther } from "ethers";
import { loadEnv, requireEnv } from "./config/env.js";
import { deriveChildPublicKey } from "./crypto/kdf.js";
import { EthereumAgent } from "./chains/ethereum.js";

export * from "./crypto/kdf.js";
export * from "./services/mpcSigner.js";
export * from "./chains/ethereum.js";
export * from "./chains/config.js";
export { EvmExecutor, type EvmExecutorLike, type MpcSignerLike } from "./chains/evmExecutor.js";
export * from "./services/nonceManager.js";
export * from "./policy/guard.js";
export * from "./agent/intentGateway.js";
export * from "./errors.js";
export { loadEnv } from "./config/env.js";

const DEFAULT_PATH = "ethereum-1";

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const env = loadEnv();

  switch (cmd) {
    case "address": {
      const path = rest[0] ?? DEFAULT_PATH;
      const account = requireEnv(env, "NEAR_ACCOUNT_ID");
      const key = deriveChildPublicKey(env.MPC_ROOT_PUBLIC_KEY, account, path);
      console.log(JSON.stringify({ nearAccount: account, path, ...key }, null, 2));
      return;
    }
    case "verify": {
      const path = rest[0] ?? DEFAULT_PATH;
      const account = requireEnv(env, "NEAR_ACCOUNT_ID");
      const provider = new JsonRpcProvider({ url: env.NEAR_NODE_URL });
      const [root, derived] = await Promise.all([
        provider.callFunction({ contractId: env.MPC_CONTRACT_ID, method: "public_key", args: {} }),
        provider.callFunction({
          contractId: env.MPC_CONTRACT_ID,
          method: "derived_public_key",
          args: { path, predecessor: account },
        }),
      ]);
      const local = deriveChildPublicKey(env.MPC_ROOT_PUBLIC_KEY, account, path);
      const rootOk = root === env.MPC_ROOT_PUBLIC_KEY;
      const derivedOk = derived === local.nearPublicKey;
      console.log(JSON.stringify({ rootOk, derivedOk, onChainRoot: root, onChainDerived: derived, local }, null, 2));
      if (!rootOk || !derivedOk) process.exitCode = 1;
      return;
    }
    case "send": {
      const [path, to, eth, data] = rest;
      if (!path || !to || !eth) throw new Error("usage: send <path> <to> <amountEth> [data]");
      const agent = new EthereumAgent({ env });
      const from = agent.addressFor(path);
      console.error(`Agent ${from} → ${to}: ${eth} ETH (balance ${formatEther(await agent.provider.getBalance(from))})`);
      console.error("Requesting MPC signature from", env.MPC_CONTRACT_ID, "…");
      const res = await agent.sendTransaction(path, { to, value: parseEther(eth), ...(data ? { data } : {}) });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    default:
      console.error("usage: ghostsign <address|verify|send> …");
      process.exitCode = 2;
  }
}

const isEntry = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("src/index.ts");
if (isEntry) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
