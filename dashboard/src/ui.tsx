import { useEffect, useState, type ReactNode } from "react";

export function Card({ title, icon, right, children, className = "" }: {
  title: string;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-zinc-800/80 bg-zinc-900/50 backdrop-blur-sm ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-zinc-800/80 px-5 py-3.5">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-wide text-zinc-300 uppercase">
          {icon}
          {title}
        </h2>
        {right}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

const TONES = {
  zinc: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
  emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  sky: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  violet: "border-violet-500/30 bg-violet-500/10 text-violet-300",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  red: "border-red-500/40 bg-red-500/10 text-red-300",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = "zinc", children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function CopyField({ label, value, display }: { label: string; value: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-medium tracking-wider text-zinc-500 uppercase">{label}</div>
      <button
        type="button"
        title="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
        className="group flex w-full min-w-0 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-left font-mono text-[13px] text-zinc-200 transition hover:border-zinc-600"
      >
        <span className="min-w-0 flex-1 truncate">{display ?? value}</span>
        <span className="shrink-0 text-[11px] text-zinc-500 group-hover:text-zinc-300">{copied ? "copied" : "copy"}</span>
      </button>
    </div>
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 font-mono text-xs text-sky-300 underline decoration-sky-500/30 underline-offset-2 hover:text-sky-200 hover:decoration-sky-300"
    >
      {children}
      <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
        <path d="M4 2h6v6M10 2 3 9" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </a>
  );
}

/** Re-render every `ms` (for elapsed timers). */
export function useTick(active: boolean, ms = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

export function Spinner({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`animate-spin ${className}`} aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export const Icon = {
  ghost: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path d="M12 3C8 3 5.5 5.8 5.5 9.6V20l2.1-1.5 2.1 1.5 2.3-1.5 2.3 1.5 2.1-1.5 2.1 1.5V9.6C18.5 5.8 16 3 12 3Z" fill="currentColor" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  ),
  bolt: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" fill="currentColor" />
    </svg>
  ),
  list: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
};
