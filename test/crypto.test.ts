import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import elliptic from "elliptic";
import { Transaction, getBytes, keccak256, toUtf8Bytes } from "ethers";
import { KeyPair } from "near-api-js";
import {
  SECP256K1_HALF_N,
  SECP256K1_N,
  deriveChildPublicKey,
  deriveEpsilon,
  parseNearSecp256k1PublicKey,
} from "../src/crypto/kdf.js";
import { reconstructEvmSignature } from "../src/chains/ethereum.js";
import { MpcSigner } from "../src/services/mpcSigner.js";
import { fakeMpc } from "./helpers/fakeMpc.js";
import { loadEnv } from "../src/config/env.js";

const ec = new elliptic.ec("secp256k1");

// Live values from v1.signer-prod.testnet (view `public_key` and
// `derived_public_key {path:"ethereum-1", predecessor:"ghostsign.testnet"}`), fetched 2026-11-05.
const TESTNET_ROOT =
  "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";
const TESTNET_DERIVED =
  "secp256k1:3EFjnUYhRxQxcuFFd8n4Le1V1ZW2Wo5kBjFS2B2rPqFqv52pePn7aL3spUvaNSX7S5PScCG4akoFueXRLDzSwEr9";

describe("kdf", () => {
  it("matches the live MPC contract's derived_public_key", () => {
    const k = deriveChildPublicKey(TESTNET_ROOT, "ghostsign.testnet", "ethereum-1");
    assert.equal(k.nearPublicKey, TESTNET_DERIVED);
    assert.equal(k.ethereumAddress, "0x29C652bC6eccC7A9106eb4b41FbA4881dA6c9f3F");
    assert.equal(k.uncompressedPublicKey.length, 2 + 130);
  });

  it("is deterministic and separates accounts and paths", () => {
    const a = deriveChildPublicKey(TESTNET_ROOT, "alice.testnet", "ethereum-1").ethereumAddress;
    assert.equal(a, deriveChildPublicKey(TESTNET_ROOT, "alice.testnet", "ethereum-1").ethereumAddress);
    assert.notEqual(a, deriveChildPublicKey(TESTNET_ROOT, "alice.testnet", "ethereum-2").ethereumAddress);
    assert.notEqual(a, deriveChildPublicKey(TESTNET_ROOT, "bob.testnet", "ethereum-1").ethereumAddress);
  });

  it("derived public key equals (root_sk + ε)·G", () => {
    const rootSecret = 0x1234567890abcdefn;
    const mpc = fakeMpc(rootSecret);
    const sk = (rootSecret + deriveEpsilon("agent.testnet", "base-1")) % SECP256K1_N;
    const expected = ec.keyFromPrivate(sk.toString(16).padStart(64, "0"), "hex").getPublic("hex");
    assert.equal(deriveChildPublicKey(mpc.rootNear, "agent.testnet", "base-1").uncompressedPublicKey, `0x${expected}`);
  });

  it("rejects the truncated root key from the original spec", () => {
    assert.throws(
      () => parseNearSecp256k1PublicKey("secp256k1:4NfTiv3UsGa5qcnevdheeDUQXHgdd3auYoAFTxR136q3"),
      /64 bytes/,
    );
  });
});

describe("EVM signature reconstruction", () => {
  const mpc = fakeMpc(0xdeadbeefcafebaben);
  const account = "ghostsign-agent.testnet";
  const path = "ethereum-1";
  const from = deriveChildPublicKey(mpc.rootNear, account, path).ethereumAddress;

  for (const highS of [false, true]) {
    it(`recovers the derived address (${highS ? "high-s normalised" : "low-s"})`, () => {
      for (let i = 0; i < 25; i++) {
        const digest = getBytes(keccak256(toUtf8Bytes(`msg-${highS}-${i}`)));
        const sig = reconstructEvmSignature(digest, mpc.sign(digest, account, path, highS), from);
        assert.equal(sig.normalized, highS);
        assert.ok(BigInt(sig.s) <= SECP256K1_HALF_N, "s must be low (EIP-2)");
      }
    });
  }

  it("refuses a signature from a different key", () => {
    const digest = getBytes(keccak256(toUtf8Bytes("x")));
    const other = deriveChildPublicKey(mpc.rootNear, account, "ethereum-2").ethereumAddress;
    assert.throws(() => reconstructEvmSignature(digest, mpc.sign(digest, account, path, false), other), /does not recover/);
  });

  it("produces a valid signed Sepolia EIP-1559 transaction", () => {
    const tx = Transaction.from({
      type: 2,
      chainId: 11155111n,
      nonce: 0,
      to: "0x000000000000000000000000000000000000dEaD",
      value: 1n,
      data: "0x",
      gasLimit: 21000n,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_500_000_000n,
    });
    const digest = getBytes(tx.unsignedHash);
    const sig = reconstructEvmSignature(digest, mpc.sign(digest, account, path, true), from);
    tx.signature = sig;
    assert.equal(tx.from, from);
    assert.equal(Transaction.from(tx.serialized).from, from);
  });
});

describe("MpcSigner input validation", () => {
  const env = loadEnv({
    NEAR_ACCOUNT_ID: "ghostsign.testnet",
    NEAR_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(),
    MPC_ROOT_PUBLIC_KEY: TESTNET_ROOT,
  });
  const signer = new MpcSigner({ env });

  it("uses 300 TGas and the configured deposit", () => {
    assert.equal(signer.depositYocto, 50_000_000_000_000_000_000_000n); // 0.05 NEAR default
  });

  it("rejects non-32-byte payloads before touching the network", async () => {
    await assert.rejects(signer.requestMpcSignature(new Uint8Array(31), "ethereum-1"), /32 bytes/);
    await assert.rejects(signer.requestMpcSignature(new Uint8Array(32), "ethereum-1"), /all-zero/);
  });
});
