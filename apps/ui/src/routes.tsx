import { Route, Routes } from "react-router";
import { HomePage } from "./pages/HomePage.tsx";
import { InboxPage } from "./pages/InboxPage.tsx";
import { ExtensionsPage, MemoryPage, NotFoundPage } from "./pages/PlaceholderPages.tsx";
import { ProjectPage } from "./pages/ProjectPage.tsx";
import { SessionPage } from "./pages/SessionPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { Shell } from "./shell/Shell.tsx";

/**
 * Routes mirror the spec's Interface module (K): home, project pages with tabs, live session,
 * inbox, memory, extensions, settings. Separate from the router so tests can mount them in a
 * MemoryRouter.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomePage />} />
        <Route path="projects/:id/:tab?" element={<ProjectPage />} />
        <Route path="sessions/:id" element={<SessionPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="extensions" element={<ExtensionsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
