/**
 * GhostSign Phase 2 demo: an "agent" submits intents through the gateway.
 *
 *   npx tsx scripts/demo-agent.ts              2 live txs (Eth Sepolia + Base Sepolia) + 3 blocked intents
 *   npx tsx scripts/demo-agent.ts --dry        only the blocked intents (no NEAR / ETH spent)
 *   npx tsx scripts/demo-agent.ts --concurrent also fire 2 Eth Sepolia intents at once to exercise the nonce queue
 *
 * Funds go to the agent's own `ethereum-2` address, so nothing leaves your control.
 */
import { formatEther } from "ethers";
import { IntentGateway, type IntentResult } from "../src/agent/intentGateway.js";
import { SUPPORTED_CHAINS } from "../src/chains/config.js";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");
const CONCURRENT = args.has("--concurrent");

const gateway = IntentGateway.fromEnv({
  onEvent: (e) => {
    if (e.type === "intent.signing") console.log(`   ↳ policy OK, requesting NEAR MPC signature for ${e.from}…`);
  },
});

const agent = gateway.addressFor("ethereum-sepolia", "ethereum-1");
const treasury = gateway.addressFor("ethereum-sepolia", "ethereum-2");
const baseAgent = gateway.addressFor("base-sepolia", "ethereum-1");

console.log("═══ GhostSign agent demo ═══");
console.log(`agent (ethereum-1):   ${agent}`);
console.log(`same on Base Sepolia: ${baseAgent === agent ? "✔ identical" : `✘ ${baseAgent}`}`);
console.log(`destination (ethereum-2): ${treasury}`);
const status = gateway.policy.status(SUPPORTED_CHAINS);
for (const [chain, s] of Object.entries(status.chains)) {
  console.log(`policy ${chain}: ≤ ${formatEther(s.maxPerTxWei)} ETH/tx, ≤ ${formatEther(s.dailyCapWei)} ETH/24h`);
}
console.log();

function show(label: string, r: IntentResult): void {
  if (r.success) {
    console.log(`✅ ${label}: nonce ${r.nonce}, ${r.executionTimeMs} ms`);
    console.log(`   ${r.explorerUrl}`);
    console.log(`   NEAR MPC tx: https://testnet.nearblocks.io/txns/${r.nearTxHash}`);
  } else {
    console.log(`⛔ ${label}: ${r.code} — ${r.error}`);
    console.log(`   rejected before MPC call: ${r.rejectedBeforeSigning}, ${r.executionTimeMs} ms`);
  }
}

const results: Array<[string, IntentResult, boolean]> = []; // [label, result, expectedSuccess]

if (!DRY) {
  console.log("→ Intent 1: 0.0001 ETH on Ethereum Sepolia");
  const r1 = await gateway.execute({
    chain: "ethereum-sepolia",
    to: treasury,
    amount: "0.0001",
    reason: "Demo: pay treasury on Ethereum Sepolia",
  });
  show("Ethereum Sepolia", r1);
  results.push(["eth", r1, true]);

  console.log("→ Intent 2: 0.0001 ETH on Base Sepolia (same derived address)");
  const r2 = await gateway.execute({
    chain: "base-sepolia",
    to: treasury,
    amount: "0.0001",
    reason: "Demo: pay treasury on Base Sepolia",
  });
  show("Base Sepolia", r2);
  results.push(["base", r2, true]);

  if (CONCURRENT) {
    console.log("→ Intents 3+4: two Ethereum Sepolia intents submitted concurrently");
    const [a, b] = await Promise.all(
      [1, 2].map((i) =>
        gateway.execute({ chain: "ethereum-sepolia", to: treasury, amount: "0.00001", reason: `Concurrent #${i}` }),
      ),
    );
    show("Concurrent #1", a!);
    show("Concurrent #2", b!);
    results.push(["c1", a!, true], ["c2", b!, true]);
    if (a!.success && b!.success) console.log(`   distinct nonces: ${a!.nonce !== b!.nonce ? "✔" : "✘"}`);
  }
  console.log();
}

console.log("→ Violation A: 0.02 ETH (per-tx cap is 0.01)");
const vA = await gateway.execute({ chain: "ethereum-sepolia", to: treasury, amount: "0.02", reason: "Agent overspend attempt" });
show("Over cap", vA);
results.push(["capA", vA, false]);

console.log("→ Violation B: send to burn address 0x…dEaD");
const vB = await gateway.execute({
  chain: "base-sepolia",
  to: "0x000000000000000000000000000000000000dEaD",
  amount: "0.0001",
  reason: "Agent tries to burn funds",
});
show("Burn address", vB);
results.push(["burn", vB, false]);

console.log("→ Violation C: emergency kill switch engaged");
gateway.policy.freeze("operator pressed the kill switch");
const vC = await gateway.execute({ chain: "ethereum-sepolia", to: treasury, amount: "0.0001", reason: "Tx while frozen" });
gateway.policy.unfreeze();
show("Frozen", vC);
results.push(["frozen", vC, false]);

const ok = results.every(([, r, expected]) => r.success === expected && (expected || (!r.success && r.rejectedBeforeSigning)));
console.log(`\n${ok ? "✔ demo passed" : "✘ demo had unexpected outcomes"}`);
if (!ok) process.exitCode = 1;
