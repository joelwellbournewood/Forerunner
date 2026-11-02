import type { ReactNode } from "react";
import { useUiState } from "../store/context.tsx";
import { buttonClassName } from "./ui.tsx";

/** The look of an inline link (a PR in a table, "source" after a note). */
export const INLINE_LINK_CLASS = "text-blue-700 hover:underline dark:text-blue-300";

/**
 * A link that leaves the app, the one way the desktop UI opens one (a test forbids
 * `target="_blank"` anywhere else). In the desktop shell the link has no target: the webview
 * navigates, and `windows.rs` (`on_navigation`) opens it in the system browser instead. The
 * Tasks tab's PR link, a `target="_blank"` link then, did nothing in the shell:
 * tauri-plugin-opener's page script cancelled the click and called `plugin:opener|open_url`,
 * which the ACL refuses. The shell now builds that plugin without its script (`lib.rs`,
 * `opener_plugin`), and a new-window request (in WebView2, a Ctrl- or Shift-click here) goes to
 * `on_new_window`, which hands a web page to the system browser the same way. In a browser tab
 * it opens a new tab. `variant="inline"` is a text link; the default is a secondary button.
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
