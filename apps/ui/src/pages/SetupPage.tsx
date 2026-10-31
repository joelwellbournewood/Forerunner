import { type ClipboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  describeError,
  isRouteMissing,
  type SetupCheckView,
  type SetupStatusView,
} from "../api/client.ts";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { Button, ErrorBanner, INPUT_CLASS, Loading } from "../components/ui.tsx";
import { useClient, useUiState } from "../store/context.tsx";

/**
 * The setup assistant (ADR 0092): the first thing a new install shows. The human pastes the
 * Anthropic key (or Claude subscription token) and the GitHub token into the app; the daemon
 * checks each one the moment it is pasted, with the same checks as `fr setup`, and stores it in
 * the OS keychain only when it passes. Nothing here keeps a value after it is sent: the field
 * is cleared on success and the daemon never sends a value back.
 */

const STEPS = ["Welcome", "Claude", "GitHub", "Done"] as const;
type Step = (typeof STEPS)[number];

/** The browser's own time zone, the default for a fresh install whose daemon says UTC. */
function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function StepDots({ step }: { step: Step }) {
  const at = STEPS.indexOf(step);
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Setup steps">
      {STEPS.map((s, i) => (
        <li
          key={s}
          aria-current={i === at ? "step" : undefined}
          className={`rounded-full px-2 py-0.5 ${
            i === at
              ? "bg-blue-600 text-white"
              : i < at
                ? "bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200"
                : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          }`}
        >
          {i < at ? "✓ " : ""}
          {s}
        </li>
      ))}
    </ol>
  );
}

function CheckResult({ result }: { result: SetupCheckView | null }) {
  if (!result) return null;
  // When a saved key is used (U-049): a replaced key at once; the first key of its kind once
  // the background service restarts, which finishing or leaving the assistant does.
  const inUse = result.ok
    ? result.status.restartNeeded
      ? "Forerunner restarts its background service once when you finish or leave this assistant, and uses it from then on."
      : "In use from the next request. No restart needed."
    : null;
  return (
    <div
      role="status"
      data-testid="setup-check-result"
      className={`rounded border px-3 py-2 text-sm ${
        result.ok && !result.problems.length
          ? "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
          : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      }`}
    >
      <p className="font-medium">
        {result.ok ? "✓ " : ""}
        {result.summary}
      </p>
      {result.problems.length ? (
        <ul className="mt-1 list-disc pl-5">
          {result.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {result.repos?.length ? <ReachableRepos repos={result.repos} /> : null}
      {inUse ? (
        <p className="mt-1" data-testid="setup-in-use">
          {inUse}
        </p>
      ) : null}
    </div>
  );
}

const ACCESS_LABEL = {
  write: "read and write",
  read: "read only",
  admin: "admin (more than needed)",
} as const;
/** Repositories listed at most; the rest are counted. */
const REPOS_SHOWN = 20;

/** The repositories a GitHub token reaches, with its access to each (U-051). */
function ReachableRepos({ repos }: { repos: NonNullable<SetupCheckView["repos"]> }) {
  const shown = repos.slice(0, REPOS_SHOWN);
  return (
    <div className="mt-2" data-testid="setup-github-repos">
      <p className="font-medium">Repositories this token reaches:</p>
      <ul className="mt-1 pl-1">
        {shown.map((r) => (
          <li key={r.fullName}>
            <span className="font-mono">{r.fullName}</span>: {ACCESS_LABEL[r.access]}
          </li>
        ))}
      </ul>
      {repos.length > shown.length ? <p>and {repos.length - shown.length} more</p> : null}
    </div>
  );
}

/**
 * One paste box: a password field, a Paste button (the clipboard, when the webview allows it)
 * and a check that runs by itself right after a paste.
 */
function SecretBox({
  label,
  placeholder,
  busy,
  onCheck,
  testId,
}: {
  label: string;
  placeholder: string;
  busy: boolean;
  onCheck: (value: string) => void;
  testId: string;
}) {
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const submit = (v: string) => {
    const trimmed = v.trim();
    if (!trimmed || busy) return;
    // A value split by a line break or a space (copied from a wrapped e-mail or document) is
    // never sent; the hint says so without showing it (U-053). The daemon refuses it as well.
    if (/\s/.test(trimmed)) {
      setValue("");
      setHint(
        `It has ${/[\r\n]/.test(trimmed) ? "a line break" : "a space"} inside, so it was not checked or saved. Copy it again in one piece, from the page that shows it, and paste it.`,
      );
      return;
    }
    setHint(null);
    onCheck(trimmed);
    setValue("");
  };
  const pasteFromClipboard = async () => {
    setHint(null);
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) submit(text);
      else setHint("The clipboard is empty. Copy the key first.");
    } catch {
      setHint("Click in the box and press Ctrl+V to paste.");
      input.current?.focus();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (text.trim()) {
      e.preventDefault();
      submit(text);
    }
  };
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor={`${testId}-input`}>
        {label}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={`${testId}-input`}
          ref={input}
          data-testid={`${testId}-input`}
          type={shown ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit(value);
          }}
          className={`${INPUT_CLASS} min-w-0 flex-1 font-mono`}
        />
        <Button onClick={() => setShown((s) => !s)} disabled={busy} aria-pressed={shown}>
          {shown ? "Hide" : "Show"}
        </Button>
        <Button onClick={pasteFromClipboard} disabled={busy} data-testid={`${testId}-paste`}>
          Paste
        </Button>
        <Button
          variant="primary"
          onClick={() => submit(value)}
          disabled={busy || !value.trim()}
          data-testid={`${testId}-check`}
        >
          {busy ? "Checking…" : "Check and save"}
        </Button>
      </div>
      {hint ? <p className="text-xs text-neutral-600 dark:text-neutral-400">{hint}</p> : null}
    </div>
  );
}

function Saved({ children }: { children: ReactNode }) {
  return (
    <p
      data-testid="setup-saved"
      className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
    >
      ✓ {children}
    </p>
  );
}

/**
 * Where a pasted key is kept, as the daemon's vault reports it (`/health` `vaultBackend`): the
 * OS credential store only when that is the backend (U-077: the page said "never in a file"
 * while the vault had fallen back to its encrypted file).
 */
export function vaultWhere(backend: string | null | undefined): string {
  if (backend === "keyring")
    return "stored in your computer's secure credential store, never in a file";
  if (backend === "memory") return "kept in memory only until Forerunner closes";
  return "stored in an encrypted file on this computer";
}

export function SetupPage() {
  const client = useClient();
  const vaultBackend = useUiState((s) => s.connection.health?.vaultBackend ?? null);
  const navigate = useNavigate();
  const [status, setStatus] = useState<SetupStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("Welcome");
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [claudeMode, setClaudeMode] = useState<"key" | "subscription">("key");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SetupCheckView | null>(null);
  const [restarting, setRestarting] = useState(false);
  // U-049: a key added here for the first time is used once the background service restarts.
  // Leaving the assistant another way than its buttons (the sidebar, a link) finishes it, so
  // the restart is not lost; Finish and "Set up later" mark it done themselves.
  const leaving = useRef({ restartNeeded: false, finished: false });
  useEffect(() => {
    leaving.current.restartNeeded = status?.restartNeeded === true;
  }, [status]);
  useEffect(
    () => () => {
      if (leaving.current.restartNeeded && !leaving.current.finished) {
        leaving.current.finished = true;
        void client.setupFinish().catch(() => undefined);
      }
    },
    [client],
  );

  const load = () => {
    setLoadError(null);
    client.setupStatus().then(
      (s) => {
        setStatus(s);
        setName(s.name);
        setTimezone(s.timezone && s.timezone !== "UTC" ? s.timezone : localTimezone());
      },
      (e) =>
        setLoadError(
          isRouteMissing(e)
            ? "This background service is older than the app and has no setup assistant. Restart Forerunner."
            : describeError(e),
        ),
    );
  };
  useEffect(load, [client]);

  const go = (next: Step) => {
    setError(null);
    setResult(null);
    setStep(next);
  };

  const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(describeError(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const check = async (fn: () => Promise<SetupCheckView>) => {
    setResult(null);
    const r = await run(fn);
    if (r) {
      setResult(r);
      setStatus(r.status);
    }
  };

  const finish = async () => {
    leaving.current.finished = true;
    const r = await run(() => client.setupFinish());
    if (!r) return;
    if (!r.restarting) {
      navigate("/", { replace: true });
      return;
    }
    // The daemon restarts so the runtime picks up the new credentials; the desktop shell
    // relaunches it and reloads this window. Elsewhere, wait for it to answer again.
    setRestarting(true);
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 1500));
    while (Date.now() - started < 120_000) {
      try {
        await client.health();
        navigate("/", { replace: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    setRestarting(false);
    setError("The background service did not come back. Close Forerunner and open it again.");
  };

  if (loadError) return <ErrorBanner message={loadError} onRetry={load} />;
  if (!status) return <Loading what="setup" />;
  const creds = status.credentials;
  const hasModel = creds.anthropicApiKey || creds.subscription;

  return (
    <section
      aria-labelledby="setup-title"
      data-testid="setup-page"
      className="mx-auto max-w-2xl space-y-5 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 id="setup-title" className="text-xl font-semibold">
          Set up Forerunner
        </h1>
        <StepDots step={step} />
      </div>
      {error ? <ErrorBanner message={error} /> : null}

      {step === "Welcome" ? (
        <div className="space-y-4">
          <p className="text-sm">
            Forerunner needs two things to work for you: access to Claude (the AI models) and access
            to GitHub (where your projects live). This takes about five minutes. Every key is
            checked the moment you paste it and {vaultWhere(vaultBackend)}.
          </p>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Your name</span>
            <input
              data-testid="setup-name"
              className={INPUT_CLASS}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Time zone</span>
            <input
              data-testid="setup-timezone"
              className={INPUT_CLASS}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
            <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">
              Used for your daily schedule and summaries.
            </span>
          </label>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={finish} disabled={busy} data-testid="setup-later">
              Set up later
            </Button>
            <Button
              variant="primary"
              disabled={busy || !name.trim()}
              data-testid="setup-next"
              onClick={async () => {
                const s = await run(() =>
                  client.setupProfile({ name: name.trim(), timezone: timezone.trim() }),
                );
                if (s) {
                  setStatus(s);
                  go("Claude");
                }
              }}
            >
              Continue
            </Button>
          </div>
        </div>
      ) : null}

      {step === "Claude" ? (
        <div className="space-y-4">
          <p className="text-sm">
            Your agent thinks with Claude. Use an <strong>Anthropic API key</strong> (pay per use;
            the simplest) or the token of your <strong>Claude subscription</strong> (Pro or Max).
            You can add both; Forerunner uses the subscription first.
          </p>
          <div className="flex gap-2" role="radiogroup" aria-label="How you pay for Claude">
            {(
              [
                ["key", "API key"],
                ["subscription", "Claude subscription"],
              ] as const
            ).map(([mode, text]) => (
              <Button
                key={mode}
                role="radio"
                aria-checked={claudeMode === mode}
                variant={claudeMode === mode ? "primary" : "secondary"}
                onClick={() => {
                  setClaudeMode(mode);
                  setResult(null);
                }}
              >
                {text}
              </Button>
            ))}
          </div>
          {claudeMode === "key" ? (
            <div className="space-y-3">
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                <li>
                  Open the Claude Console and sign in.{" "}
                  <ExternalLink href={status.links.anthropicKeys} testId="setup-anthropic-link">
                    Get an API key
                  </ExternalLink>
                </li>
                <li>Click "Create Key", name it "Forerunner", and copy it.</li>
                <li>Paste it here. It starts with sk-ant-api.</li>
              </ol>
              {creds.anthropicApiKey ? <Saved>An API key is saved.</Saved> : null}
              <SecretBox
                label={creds.anthropicApiKey ? "Replace the API key" : "API key"}
                placeholder="sk-ant-api03-…"
                busy={busy}
                testId="setup-anthropic"
                onCheck={(v) => check(() => client.setupAnthropic(v))}
              />
            </div>
          ) : (
            <div className="space-y-3">
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                <li>
                  On a computer where Claude Code is installed and signed in, run{" "}
                  <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">
                    claude setup-token
                  </code>
                  .
                </li>
                <li>Copy the token it prints. It starts with sk-ant-oat.</li>
                <li>Paste it here.</li>
              </ol>
              {creds.subscription ? <Saved>A subscription token is saved.</Saved> : null}
              <SecretBox
                label={creds.subscription ? "Replace the subscription token" : "Subscription token"}
                placeholder="sk-ant-oat01-…"
                busy={busy}
                testId="setup-subscription"
                onCheck={(v) => check(() => client.setupAnthropic(v))}
              />
            </div>
          )}
          <CheckResult result={result} />
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => go("Welcome")} disabled={busy}>
              Back
            </Button>
            <Button
              variant={hasModel ? "primary" : "secondary"}
              onClick={() => go("GitHub")}
              disabled={busy}
              data-testid="setup-next"
            >
              {hasModel ? "Continue" : "Skip for now"}
            </Button>
          </div>
        </div>
      ) : null}

      {step === "GitHub" ? (
        <div className="space-y-4">
          <p className="text-sm">
            Your agent works on your code through GitHub: it reads it, makes branches and opens pull
            requests for you to review. Give it a token that can reach only the repositories you
            choose.
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>
              Open GitHub's token page. The permissions Forerunner needs are already filled in.{" "}
              <ExternalLink href={status.links.githubToken} testId="setup-github-link">
                Create a token on GitHub
              </ExternalLink>
            </li>
            <li>
              Under "Repository access", choose "Only select repositories" and pick the ones your
              agent may work in.
            </li>
            <li>Click "Generate token", copy it, and paste it here. It starts with github_pat_.</li>
          </ol>
          <details className="text-xs text-neutral-600 dark:text-neutral-400">
            <summary className="cursor-pointer">Permissions the token gets</summary>
            <ul className="mt-1 list-disc pl-5">
              {status.githubPermissions.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </details>
          {creds.github ? <Saved>A GitHub token is saved.</Saved> : null}
          <SecretBox
            label={creds.github ? "Replace the GitHub token" : "GitHub token"}
            placeholder="github_pat_…"
            busy={busy}
            testId="setup-github"
            onCheck={(v) => check(() => client.setupGitHub({ token: v }))}
          />
          <CheckResult result={result} />
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => go("Claude")} disabled={busy}>
              Back
            </Button>
            <Button
              variant={creds.github ? "primary" : "secondary"}
              onClick={() => go("Done")}
              disabled={busy}
              data-testid="setup-next"
            >
              {creds.github ? "Continue" : "Skip for now"}
            </Button>
          </div>
        </div>
      ) : null}

      {step === "Done" ? (
        <div className="space-y-4" data-testid="setup-done">
          <ul className="space-y-1 text-sm">
            <li>{hasModel ? "✓ Claude is connected." : "✗ Claude is not connected yet."}</li>
            <li>{creds.github ? "✓ GitHub is connected." : "✗ GitHub is not connected yet."}</li>
          </ul>
          {!hasModel || !creds.github ? (
            <p className="text-sm">
              You can finish this any time from Settings → Accounts and keys. Until Claude is
              connected your agent cannot start work.
            </p>
          ) : null}
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Spending is capped by the program, not by the agent: CHF 150 a month and CHF 5 per
            session to start with. Change both in Settings. For safer coding tasks, install Docker
            Desktop; Forerunner works without it.
          </p>
          {restarting ? (
            <Loading what="the background service with your new keys" />
          ) : (
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => go("GitHub")} disabled={busy}>
                Back
              </Button>
              <Button variant="primary" onClick={finish} disabled={busy} data-testid="setup-finish">
                Start using Forerunner
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Opens the assistant when the shell mounts while the daemon says so (a fresh install); a
 * daemon without the routes (an older one) leaves the app as it was.
 */
export function useSetupGate(): void {
  const client = useClient();
  const navigate = useNavigate();
  useEffect(() => {
    const ctrl = new AbortController();
    client.setupStatus(ctrl.signal).then(
      (s) => {
        if (s.showAssistant) navigate("/setup", { replace: true });
      },
      () => {},
    );
    return () => ctrl.abort();
  }, [client, navigate]);
}
