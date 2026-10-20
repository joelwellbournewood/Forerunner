import type { ButtonHTMLAttributes, ReactNode } from "react";
import { formatMoney, type MoneyLike, moneyTooltip, percent, spendRatio } from "../lib/money.ts";

/** Small building blocks shared by every page. Tailwind only; no component library. */

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary:
    "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300 dark:disabled:bg-blue-900",
  secondary:
    "border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300",
  ghost: "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
};

/** The button look as a class string, for links that should read as buttons (never nest a <button> in an <a>). */
export function buttonClassName(variant: ButtonVariant = "secondary", className = ""): string {
  return `inline-flex items-center gap-1 rounded px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_STYLES[variant]} ${className}`;
}

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} className={buttonClassName(variant, className)} {...rest} />;
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";

const TONE_STYLES: Record<Tone, string> = {
  neutral: "bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200",
  good: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-200",
  warn: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200",
  bad: "bg-red-100 text-red-900 dark:bg-red-900/50 dark:text-red-200",
  info: "bg-blue-100 text-blue-900 dark:bg-blue-900/50 dark:text-blue-200",
};

export function Badge({
  tone = "neutral",
  children,
  title,
  testId,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  testId?: string;
}) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${TONE_STYLES[tone]}`}
      title={title}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

export function healthTone(health: string): Tone {
  switch (health) {
    case "good":
      return "good";
    case "attention":
      return "warn";
    case "blocked":
      return "bad";
    default:
      return "neutral";
  }
}

export function statusTone(status: string): Tone {
  switch (status) {
    case "running":
    case "in_progress":
    case "claimed":
      return "info";
    case "done":
    case "completed":
    case "answered":
      return "good";
    case "needs_human":
    case "paused":
    case "in_review":
      return "warn";
    case "failed":
    case "killed":
    case "cancelled":
      return "bad";
    default:
      return "neutral";
  }
}

/** Spend against a cap: bar plus "CHF x of CHF y"; USD only in the tooltip. */
export function SpendBar({
  spent,
  cap,
  label = "Spend",
  testId,
}: {
  spent: MoneyLike;
  cap: MoneyLike;
  label?: string;
  testId?: string;
}) {
  const ratio = spendRatio(spent, cap);
  const tone = ratio >= 1 ? "bg-red-600" : ratio >= 0.8 ? "bg-amber-500" : "bg-emerald-600";
  return (
    <div data-testid={testId} title={`${moneyTooltip(spent)}; cap ${moneyTooltip(cap)}`}>
      <div className="flex items-baseline justify-between text-xs text-neutral-600 dark:text-neutral-400">
        <span>{label}</span>
        <span>
          <span className="font-medium text-neutral-900 dark:text-neutral-100">
            {formatMoney(spent)}
          </span>{" "}
          of {cap.chfMicro > 0 ? formatMoney(cap) : "no cap"}
          {cap.chfMicro > 0 ? ` (${percent(ratio)})` : ""}
        </span>
      </div>
      <div
        className="mt-1 h-2 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
      >
        <div className={`h-full ${tone}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
    </div>
  );
}

export function Money({ value, className = "" }: { value: MoneyLike; className?: string }) {
  return (
    <span className={className} title={moneyTooltip(value)}>
      {formatMoney(value)}
    </span>
  );
}

/** Never a silent spinner: every wait says what it waits for. */
export function Loading({ what }: { what: string }) {
  return (
    <output className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
      <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-blue-500" aria-hidden />
      Loading {what}…
    </output>
  );
}

export function ErrorBanner({
  message,
  onRetry,
  testId = "error-banner",
}: {
  message: string;
  onRetry?: () => void;
  testId?: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-center justify-between gap-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
    >
      <span>{message}</span>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="text-sm text-neutral-600 dark:text-neutral-400" data-testid={testId}>
      {children}
    </p>
  );
}

/** A tab or page that a later phase fills; the phase is visible in the UI. */
export function Placeholder({
  title,
  phase,
  children,
}: {
  title: string;
  phase: number;
  children?: ReactNode;
}) {
  return (
    <section
      className="rounded border border-dashed border-neutral-300 p-4 dark:border-neutral-700"
      data-testid="placeholder"
      data-phase={phase}
    >
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Coming with phase {phase}.
      </p>
      {children}
    </section>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint ? (
        <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">{hint}</span>
      ) : null}
    </label>
  );
}

export const INPUT_CLASS =
  "w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";

export function KeyCap({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-neutral-300 bg-neutral-100 px-1.5 py-0.5 font-mono text-xs dark:border-neutral-600 dark:bg-neutral-800">
      {children}
    </kbd>
  );
}
