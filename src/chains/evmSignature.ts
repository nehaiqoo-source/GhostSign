/**
 * Rebuild an Ethereum-valid ECDSA signature from a NEAR MPC (big_r, s) response.
 * Chain-agnostic: works for any EVM chain since the digest already commits to chainId.
 */
import { Signature, getAddress, getBytes, hexlify, recoverAddress, toBeHex } from "ethers";
import { SECP256K1_HALF_N, SECP256K1_N, decompressPoint } from "../crypto/kdf.js";
import type { MpcSignature } from "../services/mpcSigner.js";

export interface ReconstructedSignature {
  r: `0x${string}`;
  s: `0x${string}`;
  yParity: 0 | 1;
  /** True if s was > n/2 and was replaced by n − s (EIP-2 low-s). */
  normalized: boolean;
}

const hex32 = (n: bigint): `0x${string}` => toBeHex(n, 32) as `0x${string}`;

/**
 * Turn an MPC (R, s) into an Ethereum-valid (r, s, yParity) for `digest`, and prove it
 * recovers to `expectedAddress`.
 *
 * - r = R.x mod n. If R.x ≥ n (prob. ~2^-128) the recovery id would need bit 1, which Ethereum
 *   cannot encode — reject.
 * - yParity = parity of R.y. If s > n/2 we use s' = n − s, which corresponds to −R, so the
 *   parity flips (EIP-2 rejects high-s).
 * - The candidate is verified via ecrecover; if it does not match (e.g. a future contract
 *   changes conventions) the other parity is tried, and we fail rather than broadcast a tx
 *   from the wrong sender.
 */
export function reconstructEvmSignature(
  digest: string | Uint8Array,
  sig: Pick<MpcSignature, "bigR" | "s">,
  expectedAddress: string,
): ReconstructedSignature {
  const digestHex = hexlify(digest);
  if (getBytes(digestHex).length !== 32) throw new Error("digest must be 32 bytes");

  const R = decompressPoint(sig.bigR);
  if (R.x >= SECP256K1_N) throw new Error("R.x ≥ n: signature not representable on Ethereum; re-request");
  const r = R.x;

  let s = BigInt(`0x${sig.s.replace(/^0x/, "")}`);
  if (r === 0n || s === 0n || s >= SECP256K1_N) throw new Error("MPC returned an out-of-range signature");

  let parity = Number(R.y & 1n) as 0 | 1;
  let normalized = false;
  if (s > SECP256K1_HALF_N) {
    s = SECP256K1_N - s;
    parity = (parity ^ 1) as 0 | 1;
    normalized = true;
  }

  const want = getAddress(expectedAddress);
  for (const yParity of [parity, (parity ^ 1) as 0 | 1]) {
    const candidate = Signature.from({ r: hex32(r), s: hex32(s), yParity });
    if (recoverAddress(digestHex, candidate) === want) {
      return { r: hex32(r), s: hex32(s), yParity, normalized };
    }
  }
  throw new Error(`MPC signature does not recover to ${want}: wrong derivation path, account, or root key`);
}
