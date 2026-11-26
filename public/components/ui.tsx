import type { ReactNode } from "react";

export function Card({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-surface-raised">
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b px-4 py-2.5">
          <h2 className="text-sm font-medium">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  tone?: "default" | "bad" | "warn" | "good";
}) {
  const color =
    tone === "bad"
      ? "text-danger"
      : tone === "warn"
        ? "text-warn"
        : tone === "good"
          ? "text-ok"
          : "text-ink";
  return (
    <div className="rounded-lg border bg-surface-raised px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-ink-faint">{label}</div>
      <div className={`tabular mt-1 text-xl font-medium ${color}`}>{value}</div>
    </div>
  );
}

export function Table({
  head,
  children,
  empty,
}: {
  head: ReactNode;
  children: ReactNode;
  empty?: boolean;
}) {
  if (empty) {
    return (
      <div className="px-4 py-10 text-center text-sm text-ink-faint">
        Nothing in this window. Point a NestJS app at this collector and it will
        show up here.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-ink-faint">
          {head}
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="h-5 animate-pulse rounded bg-surface-hover"
          style={{ width: `${90 - index * 7}%` }}
        />
      ))}
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
      <strong className="font-medium">Request failed.</strong>{" "}
      <span className="text-ink-muted">{message}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-ink-faint">
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "ok" | "warn" | "bad";
}) {
  const styles =
    tone === "bad"
      ? "bg-danger/15 text-danger"
      : tone === "warn"
        ? "bg-warn/15 text-warn"
        : tone === "ok"
          ? "bg-ok/15 text-ok"
          : "bg-surface-hover text-ink-muted";
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${styles}`}>
      {children}
    </span>
  );
}

export function statusTone(code: number | null): "ok" | "warn" | "bad" | "default" {
  if (code === null) return "default";
  if (code >= 500) return "bad";
  if (code >= 400) return "warn";
  return "ok";
}
