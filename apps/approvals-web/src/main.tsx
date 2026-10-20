import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// Web fallback for approvals and chat (spec K). Served by the state service; filled in with phase 5.
function App() {
  return (
    <main className="p-4">
      <h1 className="text-xl font-semibold">Forerunner approvals</h1>
      <p data-testid="empty-state">Sign in from a paired device to see pending approvals.</p>
    </main>
  );
}

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
