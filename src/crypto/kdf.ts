/**
 * NEAR Chain Signatures key derivation (additive / non-hardened BIP32-style tweak).
 *
 * The MPC network holds a root secp256k1 key share set with public key `P_root`.
 * For a caller (`predecessor`) and a free-form `path`, it signs with the child key
 *
 *     sk_child = sk_root + ε          P_child = P_root + ε·G
 *     ε = SHA3-256("near-mpc-recovery v0.1.0 epsilon derivation:" ‖ predecessor ‖ "," ‖ path)  (mod n)
 *
 * so anyone can compute the foreign-chain address an agent controls from public data alone.
 * Mirrors `derive_epsilon` / `derive_key` in near/mpc `crypto-shared/src/kdf.rs`.
 *
 * Note: the root public key is *not* an input to the hash — it enters only through the
 * point addition. This is what makes the scheme verifiable with the `derived_public_key`
 * view method on the MPC contract.
 */
import bs58 from "bs58";
import elliptic from "elliptic";
import sha3 from "js-sha3";

const secp256k1 = new elliptic.ec("secp256k1");

export const EPSILON_DERIVATION_PREFIX = "near-mpc-recovery v0.1.0 epsilon derivation:";

/** secp256k1 group order n. */
export const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
export const SECP256K1_HALF_N = SECP256K1_N >> 1n;

type ECPoint = ReturnType<typeof secp256k1.keyFromPublic> extends { getPublic(): infer P } ? P : never;

export interface DerivedKey {
  /** 65-byte uncompressed SEC1 public key as 0x-prefixed hex (0x04‖X‖Y). */
  uncompressedPublicKey: `0x${string}`;
  /** 33-byte compressed SEC1 public key as 0x-prefixed hex. */
  compressedPublicKey: `0x${string}`;
  /** NEAR-style encoding of the derived key: `secp256k1:<base58(X‖Y)>` */
  nearPublicKey: string;
  /** EIP-55 checksummed Ethereum address. */
  ethereumAddress: `0x${string}`;
  /** The scalar tweak ε as 0x-prefixed 32-byte hex. */
  epsilon: `0x${string}`;
}

function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function bigintTo32(n: bigint): Uint8Array {
  return Uint8Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex"));
}

/**
 * Parse a NEAR-formatted secp256k1 public key (`secp256k1:<base58>`).
 * Accepts the canonical 64-byte (X‖Y) form, plus 65-byte uncompressed / 33-byte compressed SEC1.
 * Returns a validated curve point.
 */
export function parseNearSecp256k1PublicKey(key: string): ECPoint {
  const [curve, data] = key.split(":");
  if (curve !== "secp256k1" || !data) {
    throw new Error(`Expected 'secp256k1:<base58>' public key, got '${key}'`);
  }
  let raw: Uint8Array;
  try {
    raw = bs58.decode(data);
  } catch {
    throw new Error("Public key is not valid base58");
  }
  let sec1: Uint8Array;
  if (raw.length === 64) sec1 = Uint8Array.from([0x04, ...raw]);
  else if (raw.length === 65 && raw[0] === 0x04) sec1 = raw;
  else if (raw.length === 33 && (raw[0] === 0x02 || raw[0] === 0x03)) sec1 = raw;
  else {
    throw new Error(
      `secp256k1 public key must decode to 64 bytes (X‖Y), got ${raw.length} bytes — the key is probably truncated`,
    );
  }
  const point = secp256k1.keyFromPublic(Buffer.from(sec1)).getPublic();
  if (!point.validate() || point.isInfinity()) throw new Error("Public key is not a valid secp256k1 point");
  return point;
}

/** ε = SHA3-256(prefix ‖ predecessor ‖ "," ‖ path) mod n, as a bigint. */
export function deriveEpsilon(predecessorId: string, path: string): bigint {
  if (!predecessorId) throw new Error("predecessorId is required");
  const digest = sha3.sha3_256(`${EPSILON_DERIVATION_PREFIX}${predecessorId},${path}`);
  const eps = BigInt(`0x${digest}`) % SECP256K1_N;
  // Probability ~2^-256; the contract would reject it too, so fail loudly rather than return the root key.
  if (eps === 0n) throw new Error("Derived epsilon is zero");
  return eps;
}

/** Ethereum address = last 20 bytes of keccak256(X‖Y). Returned EIP-55 checksummed. */
export function publicKeyToEthereumAddress(uncompressed: Uint8Array): `0x${string}` {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error("Expected 65-byte uncompressed SEC1 public key");
  }
  const hash = sha3.keccak256(uncompressed.subarray(1));
  return toChecksumAddress(hash.slice(-40));
}

/** EIP-55 checksum (implemented locally so the KDF module has no ethers dependency). */
export function toChecksumAddress(addressHexNo0x: string): `0x${string}` {
  const lower = addressHexNo0x.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error(`Invalid address hex: ${addressHexNo0x}`);
  const hash = sha3.keccak256(lower);
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  }
  return out as `0x${string}`;
}

/**
 * Derive the child secp256k1 public key (and its Ethereum address) that the MPC network will
 * sign with when `predecessorId` calls `sign` with `path`.
 */
export function deriveChildPublicKey(rootPublicKey: string, predecessorId: string, path: string): DerivedKey {
  const root = parseNearSecp256k1PublicKey(rootPublicKey);
  const epsilon = deriveEpsilon(predecessorId, path);
  const child = secp256k1.g.mul(epsilon.toString(16)).add(root);
  if (child.isInfinity()) throw new Error("Derived public key is the point at infinity");

  const uncompressed = Uint8Array.from(child.encode("array", false));
  const compressed = Uint8Array.from(child.encode("array", true));
  return {
    uncompressedPublicKey: toHex(uncompressed),
    compressedPublicKey: toHex(compressed),
    nearPublicKey: `secp256k1:${bs58.encode(uncompressed.subarray(1))}`,
    ethereumAddress: publicKeyToEthereumAddress(uncompressed),
    epsilon: toHex(bigintTo32(epsilon)),
  };
}

/** Convenience: the agent's Ethereum address for a given derivation path. */
export function deriveEthereumAddress(rootPublicKey: string, predecessorId: string, path: string): `0x${string}` {
  return deriveChildPublicKey(rootPublicKey, predecessorId, path).ethereumAddress;
}

/** Decompress a 33-byte SEC1 point (hex, with or without 0x) into its affine coordinates. */
export function decompressPoint(compressedHex: string): { x: bigint; y: bigint } {
  const clean = compressedHex.replace(/^0x/, "");
  if (!/^0[23][0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`Expected 33-byte compressed secp256k1 point, got '${compressedHex}'`);
  }
  const p = secp256k1.keyFromPublic(clean, "hex").getPublic();
  if (!p.validate() || p.isInfinity()) throw new Error("big_r is not a valid secp256k1 point");
  return { x: BigInt(`0x${p.getX().toString(16)}`), y: BigInt(`0x${p.getY().toString(16)}`) };
}
