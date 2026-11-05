import "dotenv/config";
import { z } from "zod";

const nearAccountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "invalid NEAR account id");

const emptyToUndefined = (v: unknown): unknown => (typeof v === "string" && v.trim() === "" ? undefined : v);

const decimalEth = /^\d+(\.\d{1,18})?$/;

const boolFlag = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase();
  if (s === "") return undefined;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return v;
}, z.boolean().optional());

/** Comma-separated list of 0x addresses → lower-cased array. */
const addressList = z.preprocess(
  (v) =>
    typeof v === "string"
      ? v
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : v,
  z.array(z.string().regex(/^0x[0-9a-f]{40}$/, "must be a 0x-prefixed 20-byte address")).optional(),
);

const EnvSchema = z.object({
  NEAR_NETWORK_ID: z.enum(["testnet", "mainnet"]).default("testnet"),
  NEAR_NODE_URL: z.url().default("https://rpc.testnet.near.org"),
  NEAR_ACCOUNT_ID: z.preprocess(emptyToUndefined, nearAccountId.optional()),
  NEAR_PRIVATE_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/, "NEAR_PRIVATE_KEY must be 'ed25519:<base58>'")
      .optional(),
  ),
  MPC_CONTRACT_ID: nearAccountId.default("v1.signer-prod.testnet"),
  MPC_ROOT_PUBLIC_KEY: z
    .string()
    .regex(/^secp256k1:[1-9A-HJ-NP-Za-km-z]+$/, "MPC_ROOT_PUBLIC_KEY must be 'secp256k1:<base58>'"),
  MPC_SIGN_DEPOSIT_NEAR: z
    .string()
    .regex(/^\d+(\.\d{1,24})?$/, "MPC_SIGN_DEPOSIT_NEAR must be a decimal NEAR amount")
    .default("0.05"),
  ETHEREUM_SEPOLIA_RPC: z.url().default("https://ethereum-sepolia-rpc.publicnode.com"),
  BASE_SEPOLIA_RPC: z.url().default("https://sepolia.base.org"),

  // --- Policy guardrails (amounts in ETH, decimal strings) ---
  POLICY_MAX_PER_TX_ETH: z.string().regex(decimalEth, "must be a decimal ETH amount").default("0.01"),
  POLICY_DAILY_CAP_ETH: z.string().regex(decimalEth, "must be a decimal ETH amount").default("0.05"),
  POLICY_STRICT_MODE: boolFlag.default(false),
  POLICY_ALLOWLIST: addressList.default([]),
  POLICY_DENYLIST: addressList.default([]),
  GHOSTSIGN_FROZEN: boolFlag.default(false),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parse and validate process.env once. Throws a readable error listing every bad variable. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

/** Narrow helper for values that are optional at load time but required for a given operation. */
export function requireEnv<K extends keyof Env>(env: Env, key: K): NonNullable<Env[K]> {
  const value = env[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required environment variable ${String(key)}`);
  }
  return value as NonNullable<Env[K]>;
}
