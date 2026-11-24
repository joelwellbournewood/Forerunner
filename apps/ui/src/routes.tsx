import { Route, Routes } from "react-router";
import { ChangesPage } from "./pages/ChangesPage.tsx";
import { EmailSettingsPage } from "./pages/EmailSettingsPage.tsx";
import { ExtensionsPage } from "./pages/ExtensionsPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { InboxPage } from "./pages/InboxPage.tsx";
import { MemoryPage } from "./pages/MemoryPage.tsx";
import { PerformancePage } from "./pages/PerformancePage.tsx";
import { NotFoundPage } from "./pages/PlaceholderPages.tsx";
import { ProjectPage } from "./pages/ProjectPage.tsx";
import { SessionPage } from "./pages/SessionPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { SetupPage } from "./pages/SetupPage.tsx";
import { UpdatesPage } from "./pages/UpdatesPage.tsx";
import { Shell } from "./shell/Shell.tsx";
import { useUiState } from "./store/context.tsx";
import { personZoneOf } from "./store/store.ts";

/**
 * Routes mirror the spec's Interface module (K): home, project pages with tabs, live session,
 * inbox, memory, extensions, settings (with Capabilities -> Email below it, spec S.15), plus
 * the change log (Q), the performance view (D), the updates screen (M) and the setup assistant
 * (ADR 0092). Separate from the
 * router so tests can mount them in a MemoryRouter.
 */
export function AppRoutes() {
  // w8-two-homes (L4i-left-62): every time on a screen is written in the person's zone (`GET
  // /me`). Reading it here draws every route again when it arrives or changes (after the setup
  // assistant's save, or a re-read for another window's change), so a screen already on show
  // follows it without a reload; the pages keep their state, nothing is mounted again.
  useUiState(personZoneOf);
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomePage />} />
        <Route path="projects/:id/:tab?" element={<ProjectPage />} />
        <Route path="sessions/:id" element={<SessionPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="extensions" element={<ExtensionsPage />} />
        <Route path="changes" element={<ChangesPage />} />
        <Route path="performance" element={<PerformancePage />} />
        <Route path="updates" element={<UpdatesPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="setup" element={<SetupPage />} />
        <Route path="settings/capabilities/email" element={<EmailSettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
