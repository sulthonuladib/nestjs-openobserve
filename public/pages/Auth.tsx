import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError, auth } from "../api";
import { ErrorState } from "../components/ui";

/**
 * The unauthenticated screens: first-run setup, sign in, and accepting an invite.
 *
 * Deliberately plain and single-column — these are seen once, by an operator who
 * is already nervous about putting their telemetry on a new server. No marketing,
 * no animation, and the one thing that matters on screen: whether this instance
 * still needs an admin.
 */

const field =
  "w-full rounded border bg-surface px-3 py-2 text-sm placeholder:text-ink-faint";
const primary =
  "rounded bg-accent px-4 py-2 text-sm font-medium text-surface disabled:opacity-40";

export function Setup({ status, onDone }: { status: { instanceName: string }; onDone: () => void }) {
  const [instanceName, setInstanceName] = useState(status.instanceName);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () => auth.setup({ instanceName, name, email, password }),
    onSuccess: onDone,
  });

  return (
    <AuthShell
      title="Set up this instance"
      subtitle="There is no admin yet. Create one — this page disappears afterwards."
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <Field label="Instance name" hint="Shown in the sidebar and in invite links.">
          <input
            className={field}
            value={instanceName}
            onChange={(event) => setInstanceName(event.target.value)}
            required
          />
        </Field>
        <Field label="Your name">
          <input
            className={field}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ada Lovelace"
          />
        </Field>
        <Field label="Email">
          <input
            className={field}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </Field>
        <Field
          label="Password"
          hint="At least 10 characters. A passphrase beats a symbol soup."
        >
          <input
            className={field}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={10}
            required
          />
        </Field>
        {mutation.isError && <ErrorState error={mutation.error} />}
        <button className={primary} disabled={mutation.isPending || password.length < 10}>
          {mutation.isPending ? "Creating…" : "Create admin and continue"}
        </button>
      </form>
    </AuthShell>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () => auth.login({ email, password }),
    onSuccess: onDone,
  });

  return (
    <AuthShell title="Sign in" subtitle="This collector is private to its instance.">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <Field label="Email">
          <input
            className={field}
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </Field>
        <Field label="Password">
          <input
            className={field}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        {mutation.isError && (
          <p className="text-sm text-danger">
            Wrong email or password.
            {mutation.error instanceof ApiError && mutation.error.status !== 401
              ? ` (${mutation.error.message})`
              : ""}
          </p>
        )}
        <button className={primary} disabled={mutation.isPending}>
          {mutation.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="mt-4 text-xs text-ink-faint">
        No password? An administrator can reset it with{" "}
        <code className="rounded bg-surface-hover px-1">
          nestjs-openobserve admin reset-password --email {email || "you@example.com"}
        </code>
        . There is no self-service reset: this server may have no mail relay.
      </p>
    </AuthShell>
  );
}

export function Invite({ token, onDone }: { token: string; onDone: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const describe = useQuery({
    queryKey: ["invite", token],
    queryFn: () => auth.describeInvite(token),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => auth.acceptInvite(token, { password, name }),
    onSuccess: () => {
      void client.invalidateQueries();
      onDone();
    },
  });

  if (describe.isLoading) return <AuthShell title="Checking invite…" />;
  if (describe.isError || !describe.data) {
    return (
      <AuthShell title="This invite is not valid" subtitle="It may have expired or been used.">
        <p className="text-sm text-ink-muted">
          Ask an administrator for a new one: they can issue a link in
          Settings → Members, or run{" "}
          <code className="rounded bg-surface-hover px-1">nestjs-openobserve admin invite</code>.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={`Join as ${describe.data.role}`}
      subtitle={`You were invited as ${describe.data.email}.`}
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          accept.mutate();
        }}
      >
        <Field label="Your name">
          <input
            className={field}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <input
            className={field}
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        {accept.isError && <ErrorState error={accept.error} />}
        <button className={primary} disabled={accept.isPending || password.length < 10}>
          {accept.isPending ? "Joining…" : "Join"}
        </button>
      </form>
    </AuthShell>
  );
}

function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <div className="text-sm font-semibold">
            NestJS <span className="text-accent">OpenObserve</span>
          </div>
          <p className="text-[11px] text-ink-faint">self-hosted</p>
        </div>
        <h1 className="text-lg font-medium">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
        <div className="mt-5">{children}</div>
        <p className="mt-6 text-[11px] text-ink-faint">
          {api ? "Ingest listens on :4319 · dashboard on :4320" : null}
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-faint">{hint}</span>}
    </label>
  );
}
