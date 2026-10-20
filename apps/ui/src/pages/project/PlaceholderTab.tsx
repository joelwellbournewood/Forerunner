import type { ReactNode } from "react";
import { Placeholder } from "../../components/ui.tsx";

export function PlaceholderTab({
  title,
  phase,
  children,
}: {
  title: string;
  phase: number;
  children?: ReactNode;
}) {
  return (
    <Placeholder title={title} phase={phase}>
      {children ? (
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{children}</p>
      ) : null}
    </Placeholder>
  );
}
