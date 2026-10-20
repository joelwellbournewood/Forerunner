import { Link } from "react-router";
import { Placeholder } from "../components/ui.tsx";

/** Memory (spec K.5) lands with phase 4. */
export function MemoryPage() {
  return (
    <section aria-labelledby="memory-title">
      <h1 id="memory-title" className="mb-3 text-xl font-semibold">
        Memory
      </h1>
      <Placeholder title="Lessons by scope" phase={4}>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Separate views for each agent, the critic and shared lessons, with search, edit, delete
          and pin.
        </p>
      </Placeholder>
    </section>
  );
}

/** Extensions (spec K.6) lands with phase 6. */
export function ExtensionsPage() {
  return (
    <section aria-labelledby="extensions-title">
      <h1 id="extensions-title" className="mb-3 text-xl font-semibold">
        Extensions
      </h1>
      <Placeholder
        title="Connectors, MCP servers, skills, specialists, capabilities, model providers"
        phase={6}
      >
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Status, permissions, cost, version, toggle, remove, add from catalog or URL.
        </p>
      </Placeholder>
    </section>
  );
}

export function NotFoundPage() {
  return (
    <section>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm">
        <Link to="/" className="text-blue-700 hover:underline dark:text-blue-300">
          Back to Home
        </Link>
      </p>
    </section>
  );
}
