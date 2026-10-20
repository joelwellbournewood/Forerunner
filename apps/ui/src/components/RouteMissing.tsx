import { Link } from "react-router";
import { type KnownRouteName, routeSpec } from "../api/contracts.ts";

/**
 * The visible state of a page whose route this daemon does not serve (ADR 0032): never a
 * blank panel or a generic error. Names the route so a maintainer knows what to add and the
 * human knows an update, not a retry, fixes it.
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
      <p className="font-medium">Route not available on this daemon</p>
      <p className="mt-1">
        This daemon does not serve <code className="font-mono text-xs">{verbAndPath}</code> yet, so{" "}
        {what} cannot be shown. Check{" "}
        <Link to="/updates" className="underline">
          Updates
        </Link>{" "}
        for a newer version.
      </p>
      {children}
    </section>
  );
}
