import { Banner, Loading } from "../components/ui.tsx";

/**
 * What the page shows before it holds a session: it only ever opens from a link the state
 * service issued (the one-time code in the fragment), so there is no form to fill in.
 */
export type SignInStatus =
  | { kind: "idle" }
  | { kind: "exchanging" }
  | { kind: "error"; message: string };

export function SignIn({ status }: { status: SignInStatus }) {
  return (
    <main className="mx-auto max-w-lg p-4" data-testid="sign-in">
      <h1 className="text-xl font-semibold">Forerunner approvals</h1>
      {status.kind === "exchanging" && <Loading what="your session" />}
      {status.kind === "error" && (
        <div className="mt-3">
          <Banner tone="error" testId="sign-in-error">
            {status.message}
          </Banner>
        </div>
      )}
      {status.kind !== "exchanging" && (
        <p
          className="mt-3 text-sm text-neutral-600 dark:text-neutral-300"
          data-testid="empty-state"
        >
          Open this page from the link Forerunner sent you. Each link works once and signs this tab
          in for the scopes it was issued with; closing the tab signs out.
        </p>
      )}
    </main>
  );
}
