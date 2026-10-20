import { BrowserRouter, Route, Routes } from "react-router";
import { HomePage } from "./pages/HomePage.tsx";
import { Shell } from "./shell/Shell.tsx";

/**
 * One UI for desktop and Android. Routes mirror the spec's Interface module (K): home,
 * project pages, live session, inbox, memory, extensions, settings. Pages are filled in by
 * their milestones; the shell (header with the active project, navigation, kill switch) is
 * always present.
 */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<HomePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
