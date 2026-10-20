import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useRef } from "react";

/** Small presentational pieces shared by the screens. */
export type ButtonVariant = "primary" | "secondary" | "danger";

const BUTTON: Record<ButtonVariant, string> = {
  primary:
    "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300 dark:disabled:bg-blue-900 dark:disabled:text-blue-300",
  secondary:
    "border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100 disabled:text-neutral-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700 dark:disabled:text-neutral-500",
  danger:
    "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 dark:disabled:bg-red-900 dark:disabled:text-red-300",
};

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type={type}
      className={`rounded px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed ${BUTTON[variant]} ${className}`}
      {...rest}
    />
  );
}

export type Tone = "neutral" | "info" | "warn" | "error" | "good";

const TONE: Record<Tone, string> = {
  neutral: "bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100",
  info: "bg-blue-100 text-blue-900 dark:bg-blue-900 dark:text-blue-100",
  warn: "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  error: "bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100",
  good: "bg-green-100 text-green-900 dark:bg-green-900 dark:text-green-100",
};

export function Badge({
  tone = "neutral",
  children,
  testId,
}: {
  tone?: Tone;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export function Banner({
  tone = "info",
  children,
  testId,
}: {
  tone?: Tone;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
      className={`rounded border px-3 py-2 text-sm ${TONE[tone]} border-transparent`}
    >
      {children}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" data-testid="loading" className="text-sm text-neutral-500">
      Loading {what}…
    </p>
  );
}

/**
 * Modal on the native <dialog> element. `open` is controlled by the caller; the browser gives
 * focus trapping and Escape when it supports `showModal`, otherwise the `open` attribute.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid={testId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto w-[min(100vw-2rem,28rem)] rounded-lg border border-neutral-200 bg-white p-0 text-neutral-900 shadow-xl backdrop:bg-black/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <div className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2 py-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
