import { useEffect, useRef, useState } from "react";

export type ChainKey = "ethereum-sepolia" | "base-sepolia";

export interface ChainInfo {
  key: ChainKey;
  name: string;
  chainId: string;
  currency: string;
  explorerUrl: string;
}

export interface PolicyView {
  frozen: boolean;
  frozenReason: string | null;
  strictMode: boolean;
  chains: Partial<Record<ChainKey, { maxPerTx: string; dailyCap: string; spent: string; remaining: string }>>;
}

export interface StateView {
  network: string;
  mpcContract: string;
  nearAccount: string;
  agent: { path: string; address: string; publicKey: string; compressedPublicKey: string };
  treasury: { path: string; address: string };
  chains: ChainInfo[];
  policy: PolicyView;
}

export interface BalancesView {
  address: string;
  chains: Partial<Record<ChainKey, { ok: boolean; eth?: string; error?: string }>>;
  near: { ok: boolean; near?: string; error?: string };
  at: number;
}

export type StageName =
  | "validated"
  | "policy_passed"
  | "nonce_acquired"
  | "mpc_signing"
  | "mpc_signed"
  | "broadcast"
  | "confirmed";

export type EntryStatus = "running" | "broadcast" | "confirmed" | "blocked" | "failed";

export interface FeedEntry {
  id: string;
  source: "dashboard" | "cli-history";
  createdAt: number;
  chain: string;
  to: string;
  amount: string;
  reason: string;
  status: EntryStatus;
  stages: Array<{ stage: StageName; at: number }>;
  from?: string;
  nonce?: number;
  txHash?: string;
  explorerUrl?: string;
  nearTxHash?: string;
  blockNumber?: number;
  code?: string;
  error?: string;
  rejectedBeforeSigning?: boolean;
  executionTimeMs?: number;
}

export interface IntentInput {
  chain: ChainKey;
  to: string;
  amount: string;
  reason: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as { error?: string }).error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  state: () => request<StateView>("/api/state"),
  balances: () => request<BalancesView>("/api/balances"),
  feed: () => request<FeedEntry[]>("/api/feed"),
  submitIntent: (intent: IntentInput) =>
    request<{ id: string }>("/api/intents", { method: "POST", body: JSON.stringify(intent) }),
  setFrozen: (frozen: boolean) =>
    request<PolicyView>("/api/policy/freeze", { method: "POST", body: JSON.stringify({ frozen }) }),
};

/** Subscribe to the server's event stream; reconnects automatically (EventSource default). */
export function useEventStream(handlers: {
  onEntry: (e: FeedEntry) => void;
  onPolicy: (p: PolicyView) => void;
}): "connecting" | "live" | "offline" {
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("open", () => setStatus("live"));
    es.addEventListener("error", () => setStatus(es.readyState === EventSource.CLOSED ? "offline" : "connecting"));
    es.addEventListener("hello", (ev) => {
      setStatus("live");
      ref.current.onPolicy((JSON.parse((ev as MessageEvent<string>).data) as { policy: PolicyView }).policy);
    });
    es.addEventListener("entry", (ev) => ref.current.onEntry(JSON.parse((ev as MessageEvent<string>).data) as FeedEntry));
    es.addEventListener("policy", (ev) => ref.current.onPolicy(JSON.parse((ev as MessageEvent<string>).data) as PolicyView));
    return () => es.close();
  }, []);

  return status;
}

export const short = (s: string | undefined, head = 6, tail = 4) =>
  !s ? "" : s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

export const nearTxUrl = (network: string, hash: string) =>
  `https://${network === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${hash}`;
