import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Badge, Empty, ErrorState, Skeleton } from "../components/ui";
import { formatRelative } from "../format";

/**
 * The device-code approval page.
 *
 * This is what `npx @nestjs/observe link` opens. The CLI prints a code, the
 * operator types it here, and the CLI's next poll mints the key pair. The URI
 * deliberately does not carry the code: a link that approves itself is not a
 * confirmation.
 *
 * Note: approval currently requires no session. Before this ships to a
 * multi-user install, gate `/api/v1/link/*` behind the dashboard session
 * middleware (M1 auth work) — the whole security property of the flow is that a
 * human who can see the terminal approves it.
 */
export function Link() {
  const client = useQueryClient();
  const [code, setCode] = useState("");
  const [approved, setApproved] = useState<string | null>(null);

  const pending = useQuery({
    queryKey: ["link", "pending"],
    queryFn: () => api.pendingLinks(),
    refetchInterval: 5_000,
  });

  const approve = useMutation({
    mutationFn: (userCode: string) => api.approveLink(userCode),
    onSuccess: (result) => {
      setApproved(result.userCode);
      setCode("");
      void client.invalidateQueries({ queryKey: ["link", "pending"] });
    },
  });

  const deny = useMutation({
    mutationFn: (userCode: string) => api.denyLink(userCode),
    onSuccess: () => client.invalidateQueries({ queryKey: ["link", "pending"] }),
  });

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <header>
        <h1 className="text-lg font-medium">Link an application</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Run <code className="rounded bg-surface-hover px-1">npx @nestjs/observe link</code> in
          the project, then type the code it prints.
        </p>
      </header>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim().length >= 8) approve.mutate(code.trim().toUpperCase());
        }}
      >
        <input
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          placeholder="ABCD-EFGH"
          autoFocus
          spellCheck={false}
          className="flex-1 rounded border bg-surface-raised px-3 py-2 font-mono tracking-widest placeholder:text-ink-faint"
        />
        <button
          type="submit"
          disabled={code.trim().length < 8 || approve.isPending}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-surface disabled:opacity-40"
        >
          {approve.isPending ? "Approving…" : "Approve"}
        </button>
      </form>

      {approve.isError && <ErrorState error={approve.error} />}
      {approved && (
        <div className="rounded-lg border border-ok/40 bg-ok/10 px-4 py-3 text-sm">
          <strong className="font-medium">Approved {approved}.</strong> The CLI has received its
          key pair. It is shown once and cannot be retrieved again.
        </div>
      )}

      <section className="rounded-lg border bg-surface-raised">
        <header className="border-b px-4 py-2.5 text-sm font-medium">Waiting for approval</header>
        {pending.isLoading ? (
          <Skeleton rows={3} />
        ) : (pending.data?.items.length ?? 0) === 0 ? (
          <Empty>
            Nothing waiting. Start <code>npx @nestjs/observe link</code> and the code appears here.
          </Empty>
        ) : (
          <ul className="divide-y">
            {pending.data!.items.map((item) => (
              <li key={item.userCode} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="font-mono tracking-widest">{item.userCode}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                  {item.applicationName}
                  {item.hostname ? ` · ${item.hostname}` : ""}
                </span>
                <Badge tone="warn">{formatRelative(item.expiresAt) === "just now" ? "expired" : "pending"}</Badge>
                <button
                  className="rounded border px-2 py-0.5 text-xs hover:bg-surface-hover"
                  onClick={() => approve.mutate(item.userCode)}
                >
                  Approve
                </button>
                <button
                  className="rounded border px-2 py-0.5 text-xs text-danger hover:bg-surface-hover"
                  onClick={() => deny.mutate(item.userCode)}
                >
                  Deny
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
