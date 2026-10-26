import { type ButtonHTMLAttributes, type ReactNode, useId } from "react";
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

/**
 * A choice between a few sides that reads as a switch: "Label: [A | B]", the chosen side a
 * raised pill (light surface, border, bold; deliberately not blue, so it never reads as a
 * second primary button). Every side meets 4.5:1 in both themes (`test/contrast.ts`).
 * Native radios (visually hidden) in a `radiogroup`: one tab stop, arrow keys move the choice,
 * each side's text is its accessible name. `data-checked` marks the chosen side.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  title,
  testId,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  title?: string;
  testId?: string;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      title={title}
      data-testid={testId}
      className="inline-flex items-center gap-1.5 text-xs"
    >
      <span aria-hidden="true" className="font-medium text-neutral-700 dark:text-neutral-300">
        {label}:
      </span>
      <span className="inline-flex rounded-md border border-neutral-300 bg-neutral-100 p-0.5 dark:border-neutral-700 dark:bg-neutral-800">
        {options.map((o) => {
          const checked = o.value === value;
          return (
            <label
              key={o.value}
              data-checked={checked}
              className={`cursor-pointer select-none rounded border px-2.5 py-0.5 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-500 has-[:focus-visible]:ring-offset-1 dark:has-[:focus-visible]:ring-offset-neutral-900 ${
                checked
                  ? "border-neutral-300 bg-white font-semibold text-neutral-900 shadow-sm dark:border-neutral-400 dark:bg-neutral-600 dark:text-white"
                  : "border-transparent text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
              }`}
            >
              <input
                type="radio"
                className="sr-only"
                name={name}
                value={o.value}
                checked={checked}
                onChange={() => onChange(o.value)}
              />
              {o.label}
            </label>
          );
        })}
      </span>
    </div>
  );
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
