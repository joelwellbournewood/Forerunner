import type { ReactNode } from "react";
import { useUiState } from "../store/context.tsx";
import { buttonClassName } from "./ui.tsx";

/** The look of an inline link (a PR in a table, "source" after a note). */
export const INLINE_LINK_CLASS = "text-blue-700 hover:underline dark:text-blue-300";

/**
 * A link that leaves the app, the one way the desktop UI opens one (a test forbids
 * `target="_blank"` anywhere else). In the desktop shell the link has no target: the webview
 * navigates, and `windows.rs` (`on_navigation`) opens it in the system browser instead. A
 * `target="_blank"` there is a new-window request, which the webview dropped before the shell
 * handled `on_new_window` (the Tasks tab's PR link did nothing). In a browser tab it opens a
 * new tab. `variant="inline"` is a text link; the default is a secondary button.
 */
export function ExternalLink({
  href,
  children,
  testId,
  variant = "button",
  className,
  title,
}: {
  href: string;
  children: ReactNode;
  testId?: string;
  variant?: "button" | "inline";
  /** Extra classes (spacing) after the variant's own. */
  className?: string;
  title?: string;
}) {
  const inShell = useUiState((s) => s.config.source === "shell");
  const base = variant === "inline" ? INLINE_LINK_CLASS : buttonClassName("secondary");
  return (
    <a
      href={href}
      data-testid={testId}
      className={className ? `${base} ${className}` : base}
      {...(title ? { title } : {})}
      {...(inShell ? {} : { target: "_blank", rel: "noreferrer" })}
    >
      {children}
      {variant === "button" ? <span aria-hidden>↗</span> : null}
    </a>
  );
}
