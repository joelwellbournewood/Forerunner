import { Outlet } from "react-router";

export function Shell() {
  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header
        className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-800"
        data-testid="header"
      >
        <div className="flex items-center gap-3">
          <span className="font-semibold">Forerunner</span>
          <span
            className="rounded bg-neutral-100 px-2 py-0.5 text-sm dark:bg-neutral-800"
            data-testid="active-project"
          >
            No active project
          </span>
        </div>
        <button
          type="button"
          className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
          data-testid="kill-switch"
          aria-label="Stop all sessions"
        >
          Stop all
        </button>
      </header>
      <main className="flex-1 overflow-auto p-4">
        <Outlet />
      </main>
    </div>
  );
}
