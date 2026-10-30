import { type KnownRouteName, routeSpec } from "../api/contracts.ts";

/**
 * The visible state of a page whose route this daemon does not serve (ADR 0032): never a
 * blank panel or a generic error. Names the route so a maintainer knows what to add. It does
 * not send the human to Updates: in 1.0.2 the routes it showed for were in no version at all
 * (U-007 in docs/status/UPDATE-LOG.md), and the desktop shell already replaces a daemon older
 * than the app.
 */
export function RouteMissing({
  route,
  what,
  children,
}: {
  route: KnownRouteName;
  /** What the panel would show, e.g. "critic reviews". */
  what: string;
  children?: React.ReactNode;
}) {
  const spec = routeSpec(route);
  const verbAndPath = spec.split(" (")[0] ?? spec;
  return (
    <section
      role="status"
      className="rounded border border-dashed border-amber-400 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
      data-testid="route-missing"
      data-route={route}
    >
      <p className="font-medium">Not available in this version</p>
      <p className="mt-1">
        This part of Forerunner is not in this version yet, so {what} cannot be shown. Nothing is
        wrong with your install.
      </p>
      <p className="mt-1 text-xs">
        For maintainers: the background service does not serve{" "}
        <code className="font-mono">{verbAndPath}</code>.
      </p>
      {children}
    </section>
  );
}
