import type { ReactNode } from "react";
import { useUiState } from "../store/context.tsx";
import { buttonClassName } from "./ui.tsx";

/**
 * A link that leaves the app. In the desktop shell a plain link is intercepted and opened in
 * the system browser (`windows.rs`, `on_navigation`); elsewhere it opens a new tab.
 */
export function ExternalLink({
  href,
  children,
  testId,
}: {
  href: string;
  children: ReactNode;
  testId?: string;
}) {
  const inShell = useUiState((s) => s.config.source === "shell");
  return (
    <a
      href={href}
      data-testid={testId}
      className={buttonClassName("secondary")}
      {...(inShell ? {} : { target: "_blank", rel: "noreferrer" })}
    >
      {children}
      <span aria-hidden>↗</span>
    </a>
  );
}
