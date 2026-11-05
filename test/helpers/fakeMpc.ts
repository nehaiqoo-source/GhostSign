import bs58 from "bs58";
import elliptic from "elliptic";
import { SECP256K1_N, deriveEpsilon } from "../../src/crypto/kdf.js";
import type { MpcSignature } from "../../src/services/mpcSigner.js";

const ec = new elliptic.ec("secp256k1");

/** A locally simulated MPC network: knows the root secret, signs with root + ε. */
export function fakeMpc(rootSecret: bigint) {
  const rootPub = ec.keyFromPrivate(rootSecret.toString(16).padStart(64, "0"), "hex").getPublic();
  const rootNear = `secp256k1:${bs58.encode(Uint8Array.from(rootPub.encode("array", false)).subarray(1))}`;
  const sign = (digest: Uint8Array, predecessor: string, path: string, forceHighS = false) => {
    const sk = (rootSecret + deriveEpsilon(predecessor, path)) % SECP256K1_N;
    const sig = ec.keyFromPrivate(sk.toString(16).padStart(64, "0"), "hex").sign(Buffer.from(digest), { canonical: true });
    let R = ec.curve.pointFromX(sig.r.toString(16).padStart(64, "0"), (sig.recoveryParam! & 1) === 1);
    let s = BigInt(`0x${sig.s.toString(16)}`);
    if (forceHighS) {
      s = SECP256K1_N - s; // (r, n−s) is the same signature with −R
      R = R.neg();
    }
    return { bigR: Buffer.from(R.encode("array", true)).toString("hex"), s: s.toString(16).padStart(64, "0") };
  };
  /** An MpcSignerLike bound to one NEAR account. */
  const signerFor = (accountId: string, opts: { delayMs?: number; fail?: () => boolean } = {}) => {
    let calls = 0;
    return {
      accountId,
      get calls() {
        return calls;
      },
      async requestMpcSignature(payload: Uint8Array, path: string): Promise<MpcSignature> {
        calls++;
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.fail?.()) throw new Error("simulated MPC failure");
        const { bigR, s } = sign(payload, accountId, path, calls % 2 === 0);
        return { bigR, s, recoveryId: 0, nearTxHash: `fake-near-${calls}` };
      },
    };
  };
  return { rootNear, sign, signerFor };
}
