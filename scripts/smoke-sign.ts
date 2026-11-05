/**
 * Live smoke test: real NEAR MPC signature over an unsigned Sepolia tx, without broadcasting.
 *   npx tsx scripts/smoke-sign.ts [path]
 */
import { Transaction, getBytes } from "ethers";
import { loadEnv } from "../src/config/env.js";
import { EthereumAgent, reconstructEvmSignature, SEPOLIA_CHAIN_ID } from "../src/chains/ethereum.js";

const path = process.argv[2] ?? "ethereum-1";
const agent = new EthereumAgent({ env: loadEnv() });
const from = agent.addressFor(path);

const tx = Transaction.from({
  type: 2,
  chainId: SEPOLIA_CHAIN_ID,
  nonce: 0,
  to: "0x000000000000000000000000000000000000dEaD",
  value: 1n,
  data: "0x",
  gasLimit: 21000n,
  maxFeePerGas: 30_000_000_000n,
  maxPriorityFeePerGas: 1_500_000_000n,
});

console.error(`Agent ${from} (${agent.mpcSigner.accountId} / ${path}); requesting MPC signature…`);
const t0 = Date.now();
const mpc = await agent.mpcSigner.requestMpcSignature(getBytes(tx.unsignedHash), path);
const sig = reconstructEvmSignature(tx.unsignedHash, mpc, from);
tx.signature = sig;

console.log(
  JSON.stringify(
    {
      ok: tx.from === from,
      from,
      recoveredFrom: tx.from,
      seconds: (Date.now() - t0) / 1000,
      nearTx: `https://testnet.nearblocks.io/txns/${mpc.nearTxHash}`,
      mpcRecoveryId: mpc.recoveryId,
      yParity: sig.yParity,
      sNormalized: sig.normalized,
      rawTransaction: tx.serialized,
    },
    null,
    2,
  ),
);
