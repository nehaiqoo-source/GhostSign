import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  nearTxUrl,
  short,
  useEventStream,
  type BalancesView,
  type ChainKey,
  type FeedEntry,
  type IntentInput,
  type PolicyView,
  type StateView,
} from "./api";
import { Badge, Card, CopyField, ExtLink, Icon, Spinner, useTick, type Tone } from "./ui";

const CHAIN_LABEL: Record<string, string> = { "ethereum-sepolia": "Ethereum Sepolia", "base-sepolia": "Base Sepolia" };
const CHAIN_TONE: Record<string, Tone> = { "ethereum-sepolia": "violet", "base-sepolia": "sky" };
const BURN = "0x000000000000000000000000000000000000dEaD";

export function App() {
  const [state, setState] = useState<StateView | null>(null);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [balances, setBalances] = useState<BalancesView | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshBalances = useCallback(() => {
    api.balances().then(setBalances).catch(() => undefined);
  }, []);

  useEffect(() => {
    Promise.all([api.state(), api.feed()])
      .then(([s, f]) => {
        setState(s);
        setPolicy(s.policy);
        setFeed(f);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
    refreshBalances();
    const t = setInterval(refreshBalances, 20_000);
    return () => clearInterval(t);
  }, [refreshBalances]);

  const conn = useEventStream({
    onEntry: (entry) => {
      setFeed((prev) => {
        const i = prev.findIndex((e) => e.id === entry.id);
        if (i === -1) return [entry, ...prev];
        const next = prev.slice();
        next[i] = entry;
        return next;
      });
      if (entry.status === "confirmed") refreshBalances();
    },
    onPolicy: setPolicy,
  });

  if (loadError) {
    return (
      <Shell>
        <div className="mx-auto mt-24 max-w-lg rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-sm text-red-200">
          <div className="mb-2 font-semibold">Cannot reach the GhostSign API</div>
          <div className="font-mono text-xs text-red-300/80">{loadError}</div>
          <div className="mt-4 text-zinc-400">
            Start it with <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-200">npm run dev:all</code>.
          </div>
        </div>
      </Shell>
    );
  }

  if (!state || !policy) {
    return (
      <Shell>
        <div className="mt-32 flex items-center justify-center gap-2 text-sm text-zinc-500">
          <Spinner /> Connecting to agent…
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <Header state={state} conn={conn} />
      {policy.frozen && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <span className="size-2 animate-pulse rounded-full bg-red-400" />
          <span className="font-semibold">Kill switch engaged.</span>
          <span className="text-red-300/80">All agent signing is halted before reaching NEAR MPC. {policy.frozenReason}</span>
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6">
          <IdentityCard state={state} balances={balances} onRefresh={refreshBalances} />
          <PolicyCard policy={policy} onPolicy={setPolicy} />
        </div>
        <div className="flex flex-col gap-6 lg:col-span-2">
          <IntentPanel state={state} policy={policy} feed={feed} />
          <FeedCard feed={feed} network={state.network} />
        </div>
      </div>
      <footer className="mt-10 pb-8 text-center text-xs text-zinc-600">
        No foreign private keys exist anywhere in this system — every signature is produced by the NEAR MPC network.
      </footer>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">{children}</div>;
}

// ───────────────────────────── header ─────────────────────────────

function Header({ state, conn }: { state: StateView; conn: "connecting" | "live" | "offline" }) {
  return (
    <header className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div className="flex items-center gap-3">
        <div className="grid size-11 place-items-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
          <span className="scale-150">{Icon.ghost}</span>
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-50 sm:text-2xl">
            GhostSign <span className="font-normal text-zinc-500">//</span>{" "}
            <span className="font-medium text-zinc-300">Autonomous Agent Cross-Chain Gateway</span>
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500">Keyless multi-chain execution for AI agents via NEAR Chain Signatures</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="emerald" dot>
          NEAR {state.network === "testnet" ? "Testnet" : state.network}
        </Badge>
        <Badge tone="zinc">
          MPC <span className="font-mono">{state.mpcContract}</span>
        </Badge>
        <Badge tone={conn === "live" ? "emerald" : conn === "connecting" ? "amber" : "red"} dot>
          {conn === "live" ? "Live" : conn === "connecting" ? "Reconnecting" : "Offline"}
        </Badge>
      </div>
    </header>
  );
}

// ───────────────────────────── identity ─────────────────────────────

function IdentityCard({ state, balances, onRefresh }: { state: StateView; balances: BalancesView | null; onRefresh: () => void }) {
  return (
    <Card
      title="Agent Identity"
      icon={Icon.ghost}
      right={
        <button type="button" onClick={onRefresh} className="text-xs text-zinc-500 hover:text-zinc-300">
          refresh
        </button>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-[11px] font-medium tracking-wider text-zinc-500 uppercase">NEAR controller</div>
            <div className="mt-1 truncate font-mono text-[13px] text-zinc-200" title={state.nearAccount}>
              {state.nearAccount}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-medium tracking-wider text-zinc-500 uppercase">Derivation path</div>
            <div className="mt-1 font-mono text-[13px] text-zinc-200">{state.agent.path}</div>
          </div>
        </div>
        <CopyField label="MPC-derived secp256k1 key" value={state.agent.publicKey} display={short(state.agent.publicKey, 18, 8)} />
        <CopyField label="Foreign EVM address" value={state.agent.address} />
        <p className="text-xs leading-relaxed text-zinc-500">
          Derived from <span className="font-mono text-zinc-400">{short(state.nearAccount, 12, 8)}</span> +{" "}
          <span className="font-mono text-zinc-400">{state.agent.path}</span>. Same address on every EVM chain; no private key is
          stored anywhere.
        </p>

        <div className="space-y-2 border-t border-zinc-800 pt-4">
          {state.chains.map((c) => {
            const b = balances?.chains[c.key];
            return (
              <div key={c.key} className="flex items-center justify-between gap-3 rounded-lg bg-zinc-950/50 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`size-2 shrink-0 rounded-full ${b?.ok ? "bg-emerald-400" : b ? "bg-red-400" : "bg-zinc-600"}`} />
                  <div className="min-w-0 leading-tight">
                    <div className="truncate text-sm text-zinc-300">{c.name}</div>
                    <div className="font-mono text-[10px] text-zinc-600">chain {c.chainId}</div>
                  </div>
                </div>
                <div className="shrink-0 font-mono text-sm whitespace-nowrap text-zinc-100 tabular-nums">
                  {b?.ok ? `${Number(b.eth).toFixed(5)} ${c.currency}` : b ? "rpc error" : "…"}
                </div>
              </div>
            );
          })}
          <div className="flex items-center justify-between rounded-lg bg-zinc-950/50 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${balances?.near.ok ? "bg-emerald-400" : "bg-zinc-600"}`} />
              <span className="text-sm text-zinc-300">NEAR (MPC gas)</span>
            </div>
            <div className="shrink-0 font-mono text-sm whitespace-nowrap text-zinc-100 tabular-nums">{balances?.near.ok ? `${balances.near.near} NEAR` : "…"}</div>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ───────────────────────────── policy ─────────────────────────────

function PolicyCard({ policy, onPolicy }: { policy: PolicyView; onPolicy: (p: PolicyView) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      onPolicy(await api.setFrozen(!policy.frozen));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Policy Guard" icon={Icon.shield} right={<Badge tone={policy.strictMode ? "amber" : "zinc"}>{policy.strictMode ? "Strict allowlist" : "Open + denylist"}</Badge>}>
      <div className="space-y-4">
        {Object.entries(policy.chains).map(([key, c]) => {
          const pct = Math.min(100, (Number(c.spent) / Math.max(Number(c.dailyCap), 1e-18)) * 100);
          return (
            <div key={key}>
              <div className="mb-1.5 flex items-baseline justify-between text-sm">
                <span className="text-zinc-300">{CHAIN_LABEL[key] ?? key}</span>
                <span className="font-mono text-xs whitespace-nowrap text-zinc-400 tabular-nums">
                  {Number(c.spent).toFixed(4)} / {c.dailyCap} ETH
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${pct > 80 ? "bg-amber-400" : "bg-emerald-400"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-1.5 flex justify-between text-xs text-zinc-500">
                <span>
                  Per-tx cap <span className="font-mono text-zinc-300">{c.maxPerTx} ETH</span>
                </span>
                <span>rolling 24h</span>
              </div>
            </div>
          );
        })}

        <ul className="space-y-1 border-t border-zinc-800 pt-4 text-xs text-zinc-400">
          <li>✓ Zero & burn addresses always blocked</li>
          <li>✓ All checks run before the NEAR MPC call: no gas, no deposit on rejection</li>
        </ul>

        <button
          type="button"
          role="switch"
          aria-checked={policy.frozen}
          disabled={busy}
          onClick={() => void toggle()}
          className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3.5 text-left transition ${
            policy.frozen
              ? "border-red-500/60 bg-red-600/20 shadow-[0_0_30px_-8px_rgb(239_68_68/0.6)]"
              : "border-red-500/30 bg-red-500/5 hover:border-red-500/60 hover:bg-red-500/10"
          }`}
        >
          <div>
            <div className="text-sm font-semibold text-red-200">Emergency Freeze / Kill Switch</div>
            <div className="text-xs text-red-300/70">{policy.frozen ? "Engaged: all signing halted" : "Disengaged: agent may sign"}</div>
          </div>
          <span className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${policy.frozen ? "bg-red-500" : "bg-zinc-700"}`}>
            <span className={`inline-block size-5 rounded-full bg-white shadow transition ${policy.frozen ? "translate-x-6" : "translate-x-1"}`} />
          </span>
        </button>
        {err && <div className="text-xs text-red-300">{err}</div>}
      </div>
    </Card>
  );
}

// ───────────────────────────── intent executor ─────────────────────────────

type Mode = "single" | "burst";

function IntentPanel({ state, policy, feed }: { state: StateView; policy: PolicyView; feed: FeedEntry[] }) {
  const [chain, setChain] = useState<ChainKey>("ethereum-sepolia");
  const [mode, setMode] = useState<Mode>("single");
  const [to, setTo] = useState(state.treasury.address);
  const [amount, setAmount] = useState("0.001");
  const [reason, setReason] = useState("Pay treasury for compute credits");
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preset, setPreset] = useState<string>("normal");

  const perTxCap = policy.chains[chain]?.maxPerTx ?? "0.01";

  const presets = [
    {
      id: "normal",
      label: "Send 0.001 ETH",
      sub: "Normal execution",
      tone: "emerald" as Tone,
      apply: () => {
        setMode("single");
        setTo(state.treasury.address);
        setAmount("0.001");
        setReason("Pay treasury for compute credits");
      },
    },
    {
      id: "burst",
      label: "Multi-Chain Burst",
      sub: "Sepolia + Base in parallel",
      tone: "sky" as Tone,
      apply: () => {
        setMode("burst");
        setTo(state.treasury.address);
        setAmount("0.0005");
        setReason("Rebalance treasury across L1 and L2");
      },
    },
    {
      id: "overcap",
      label: "Over-Cap Violation",
      sub: "0.05 ETH, blocked",
      tone: "amber" as Tone,
      apply: () => {
        setMode("single");
        setTo(state.treasury.address);
        setAmount("0.05");
        setReason("Agent hallucinates a large payment");
      },
    },
    {
      id: "burn",
      label: "Burn Address Injection",
      sub: "0x…dEaD, blocked",
      tone: "red" as Tone,
      apply: () => {
        setMode("single");
        setTo(BURN);
        setAmount("0.001");
        setReason("Prompt-injected transfer to burn address");
      },
    },
  ];

  const submit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      const chains: ChainKey[] = mode === "burst" ? ["ethereum-sepolia", "base-sepolia"] : [chain];
      const ids = await Promise.all(chains.map((c) => api.submitIntent({ chain: c, to, amount, reason } satisfies IntentInput)));
      setActiveIds(ids.map((r) => r.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const active = activeIds.map((id) => feed.find((e) => e.id === id)).filter((e): e is FeedEntry => !!e);
  const overCap = Number(amount) > Number(perTxCap);

  return (
    <Card title="Intent Executor" icon={Icon.bolt} right={<span className="text-xs text-zinc-500">signs via NEAR MPC</span>}>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              setPreset(p.id);
              p.apply();
            }}
            className={`rounded-xl border px-3 py-2.5 text-left transition ${
              preset === p.id ? "border-zinc-500 bg-zinc-800/80" : "border-zinc-800 bg-zinc-950/40 hover:border-zinc-700"
            }`}
          >
            <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-100">
              <span
                className={`size-1.5 rounded-full ${
                  { emerald: "bg-emerald-400", sky: "bg-sky-400", amber: "bg-amber-400", red: "bg-red-400" }[p.tone as "emerald"] ?? "bg-zinc-400"
                }`}
              />
              {p.label}
            </div>
            <div className="mt-0.5 text-xs text-zinc-500">{p.sub}</div>
          </button>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-6">
        <div className="md:col-span-6">
          <Label>Target chain</Label>
          <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950/60 p-1">
            {(["ethereum-sepolia", "base-sepolia"] as const).map((c) => (
              <button
                key={c}
                type="button"
                disabled={mode === "burst"}
                onClick={() => setChain(c)}
                className={`rounded-md px-3 py-1.5 text-sm transition ${
                  mode === "burst" || chain === c ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {CHAIN_LABEL[c]}
              </button>
            ))}
          </div>
          {mode === "burst" && (
            <span className="ml-3 text-xs text-sky-300">
              Burst: one intent per chain, in parallel ·{" "}
              <button type="button" className="underline" onClick={() => setMode("single")}>
                single chain
              </button>
            </span>
          )}
        </div>
        <div className="md:col-span-4">
          <Label>Destination address</Label>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value.trim())}
            spellCheck={false}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 font-mono text-[13px] text-zinc-100 outline-none focus:border-zinc-500"
          />
          {to.toLowerCase() === state.treasury.address.toLowerCase() && (
            <div className="mt-1 text-xs text-zinc-500">Agent treasury ({state.treasury.path}), also MPC-controlled</div>
          )}
        </div>
        <div className="md:col-span-2">
          <Label>Amount (ETH)</Label>
          <input
            value={amount}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value.trim())}
            className={`w-full rounded-lg border bg-zinc-950/60 px-3 py-2 font-mono text-[13px] text-zinc-100 outline-none focus:border-zinc-500 ${
              overCap ? "border-amber-500/60" : "border-zinc-800"
            }`}
          />
          <div className={`mt-1 text-xs ${overCap ? "text-amber-300" : "text-zinc-500"}`}>Cap {perTxCap} ETH / tx</div>
        </div>
        <div className="md:col-span-6">
          <Label>Reason (audit trail)</Label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={submitting}
          onClick={() => void submit()}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 shadow-[0_0_24px_-6px_rgb(16_185_129/0.7)] transition hover:bg-emerald-400 disabled:opacity-60"
        >
          {submitting ? <Spinner /> : Icon.bolt}
          Execute Intent via NEAR MPC{mode === "burst" ? " ×2" : ""}
        </button>
        {policy.frozen && <span className="text-xs text-red-300">Kill switch is on: this will be blocked</span>}
        {err && <span className="text-xs text-red-300">{err}</span>}
      </div>

      {active.length > 0 && (
        <div className={`mt-6 grid gap-4 ${active.length > 1 ? "md:grid-cols-2" : ""}`}>
          {active.map((e) => (
            <Tracker key={e.id} entry={e} network={state.network} />
          ))}
        </div>
      )}
    </Card>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[11px] font-medium tracking-wider text-zinc-500 uppercase">{children}</div>;
}

// ───────────────────────────── tracker ─────────────────────────────

type StepState = "pending" | "active" | "done" | "failed";

function stepsFor(e: FeedEntry): Array<{ label: string; state: StepState; ms?: number; detail?: string }> {
  const at = (s: string) => e.stages.find((x) => x.stage === s)?.at;
  const t = {
    start: e.createdAt,
    validated: at("validated"),
    policy: at("policy_passed"),
    nonce: at("nonce_acquired"),
    signing: at("mpc_signing"),
    signed: at("mpc_signed"),
    broadcast: at("broadcast"),
    confirmed: at("confirmed"),
  };
  const done = [!!t.policy, !!t.nonce, !!t.signed, !!t.broadcast, !!t.confirmed];
  const firstOpen = done.indexOf(false);
  const terminalFail = e.status === "blocked" || e.status === "failed";
  const ends = [t.policy, t.nonce, t.signed, t.broadcast, t.confirmed];
  const starts = [t.start, t.policy, t.nonce, t.signed, t.broadcast];
  const labels = ["Policy Check", "Nonce Queue", "NEAR MPC Round", "Broadcast", "Confirmed"];
  const details = [
    undefined,
    e.nonce !== undefined ? `nonce ${e.nonce}` : undefined,
    e.nearTxHash ? short(e.nearTxHash, 6, 4) : t.signing ? "nodes signing…" : undefined,
    e.txHash ? short(e.txHash, 8, 4) : undefined,
    e.blockNumber ? `block ${e.blockNumber}` : undefined,
  ];
  return labels.map((label, i) => {
    let state: StepState = done[i] ? "done" : "pending";
    if (i === firstOpen) state = terminalFail ? "failed" : "active";
    const s = starts[i];
    const end = ends[i];
    const out: { label: string; state: StepState; ms?: number; detail?: string } = { label, state };
    if (s && end) out.ms = end - s;
    if (details[i]) out.detail = details[i];
    return out;
  });
}

function Tracker({ entry, network }: { entry: FeedEntry; network: string }) {
  const running = entry.status === "running" || entry.status === "broadcast";
  const now = useTick(running);
  const steps = stepsFor(entry);
  const elapsed = (running ? now : (entry.stages.at(-1)?.at ?? now)) - entry.createdAt;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={CHAIN_TONE[entry.chain] ?? "zinc"}>{CHAIN_LABEL[entry.chain] ?? entry.chain}</Badge>
          <span className="font-mono text-sm text-zinc-200">{entry.amount} ETH</span>
        </div>
        <span className="font-mono text-xs text-zinc-500 tabular-nums">{(elapsed / 1000).toFixed(1)}s</span>
      </div>
      <ol className="relative space-y-3">
        {steps.map((s, i) => (
          <li key={s.label} className="flex items-start gap-3">
            <div className="flex flex-col items-center">
              <StepDot state={s.state} />
              {i < steps.length - 1 && (
                <span className={`mt-1 h-4 w-px ${s.state === "done" ? "bg-emerald-500/50" : "bg-zinc-800"}`} />
              )}
            </div>
            <div className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
              <span
                className={`text-sm ${
                  s.state === "done"
                    ? "text-zinc-200"
                    : s.state === "active"
                      ? "text-emerald-300"
                      : s.state === "failed"
                        ? "text-red-300"
                        : "text-zinc-600"
                }`}
              >
                {s.label}
              </span>
              <span className="truncate font-mono text-[11px] text-zinc-500">
                {s.detail}
                {s.ms !== undefined && <span className="ml-2 text-zinc-600">{(s.ms / 1000).toFixed(1)}s</span>}
              </span>
            </div>
          </li>
        ))}
      </ol>
      {entry.code && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <div className="font-mono text-xs font-semibold text-amber-300">{entry.code}</div>
          <div className="mt-0.5 text-xs text-amber-200/80">{entry.error}</div>
          {entry.rejectedBeforeSigning && (
            <div className="mt-1 text-[11px] text-zinc-400">Blocked before NEAR MPC: 0 gas, 0 deposit spent</div>
          )}
        </div>
      )}
      {!entry.code && entry.error && <div className="mt-3 text-xs text-amber-300">{entry.error}</div>}
      {(entry.explorerUrl || entry.nearTxHash) && (
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1">
          {entry.explorerUrl && <ExtLink href={entry.explorerUrl}>{entry.chain === "base-sepolia" ? "Basescan" : "Etherscan"}</ExtLink>}
          {entry.nearTxHash && <ExtLink href={nearTxUrl(network, entry.nearTxHash)}>NEAR MPC tx</ExtLink>}
        </div>
      )}
    </div>
  );
}

function StepDot({ state }: { state: StepState }) {
  if (state === "done")
    return (
      <span className="grid size-5 place-items-center rounded-full bg-emerald-500 text-zinc-950">
        <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
          <path d="m2.5 6.2 2.2 2.2 4.8-4.9" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </span>
    );
  if (state === "active")
    return (
      <span className="pulse-ring grid size-5 place-items-center rounded-full border border-emerald-400 text-emerald-300">
        <Spinner className="size-3" />
      </span>
    );
  if (state === "failed")
    return (
      <span className="grid size-5 place-items-center rounded-full bg-red-500 text-zinc-950">
        <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
          <path d="m3 3 6 6M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </span>
    );
  return <span className="size-5 rounded-full border border-zinc-700 bg-zinc-900" />;
}

// ───────────────────────────── feed ─────────────────────────────

const STATUS: Record<FeedEntry["status"], { tone: Tone; label: string }> = {
  running: { tone: "emerald", label: "Signing" },
  broadcast: { tone: "sky", label: "Broadcast" },
  confirmed: { tone: "emerald", label: "Confirmed" },
  blocked: { tone: "amber", label: "Blocked" },
  failed: { tone: "red", label: "Failed" },
};

function FeedCard({ feed, network }: { feed: FeedEntry[]; network: string }) {
  const [filter, setFilter] = useState<"all" | "executed" | "blocked">("all");
  const shown = useMemo(
    () =>
      feed.filter((e) =>
        filter === "all" ? true : filter === "blocked" ? e.status === "blocked" || e.status === "failed" : e.status !== "blocked" && e.status !== "failed",
      ),
    [feed, filter],
  );
  const counts = {
    executed: feed.filter((e) => e.status === "confirmed" || e.status === "broadcast").length,
    blocked: feed.filter((e) => e.status === "blocked").length,
  };

  return (
    <Card
      title="Live Activity & Audit Feed"
      icon={Icon.list}
      right={
        <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5 text-xs">
          {(["all", "executed", "blocked"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-md px-2.5 py-1 capitalize transition ${filter === f ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              {f}
              {f !== "all" && <span className="ml-1 text-zinc-500">{counts[f]}</span>}
            </button>
          ))}
        </div>
      }
    >
      {shown.length === 0 ? (
        <div className="py-10 text-center text-sm text-zinc-500">No intents yet. Pick a preset above and execute.</div>
      ) : (
        <ul className="-my-2 divide-y divide-zinc-800/80">
          {shown.map((e) => (
            <FeedRow key={e.id} e={e} network={network} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function FeedRow({ e, network }: { e: FeedEntry; network: string }) {
  const st = STATUS[e.status];
  return (
    <li className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[110px_1fr_auto] sm:items-start sm:gap-4">
      <div className="flex items-center gap-2 sm:flex-col sm:items-start sm:gap-1">
        <Badge tone={st.tone} dot>
          {(e.status === "running" || e.status === "broadcast") && <Spinner className="size-3" />}
          {st.label}
        </Badge>
        <span className="text-[11px] text-zinc-600">
          {e.source === "cli-history" ? "CLI proof" : new Date(e.createdAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={CHAIN_TONE[e.chain] ?? "zinc"}>{CHAIN_LABEL[e.chain] ?? e.chain}</Badge>
          <span className="font-mono text-zinc-100">{e.amount} ETH</span>
          <span className="text-zinc-600">→</span>
          <span className="font-mono text-xs text-zinc-400" title={e.to}>
            {short(e.to, 8, 6)}
          </span>
          {e.nonce !== undefined && <span className="font-mono text-[11px] text-zinc-600">nonce {e.nonce}</span>}
          {e.blockNumber && <span className="font-mono text-[11px] text-zinc-600">block {e.blockNumber}</span>}
        </div>
        <div className="mt-1 truncate text-xs text-zinc-500" title={e.reason}>
          “{e.reason}”
        </div>
        {e.code && (
          <div className="mt-1 text-xs">
            <span className="font-mono font-semibold text-amber-300">{e.code}</span>{" "}
            <span className="text-zinc-400">{e.error}</span>
          </div>
        )}
        {!e.code && e.error && <div className="mt-1 text-xs text-amber-300/80">{e.error}</div>}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 sm:flex-col sm:items-end">
        {e.explorerUrl && e.txHash && <ExtLink href={e.explorerUrl}>{short(e.txHash, 8, 6)}</ExtLink>}
        {e.nearTxHash && <ExtLink href={nearTxUrl(network, e.nearTxHash)}>NEAR MPC</ExtLink>}
        {e.rejectedBeforeSigning && <span className="text-[11px] text-zinc-500">0 gas spent</span>}
        {e.executionTimeMs !== undefined && e.status !== "blocked" && (
          <span className="font-mono text-[11px] text-zinc-600">{(e.executionTimeMs / 1000).toFixed(1)}s</span>
        )}
      </div>
    </li>
  );
}
