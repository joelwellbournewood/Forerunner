export function HomePage() {
  return (
    <section aria-labelledby="home-title">
      <h1 id="home-title" className="text-xl font-semibold">
        Projects
      </h1>
      <p className="mt-2 text-neutral-600 dark:text-neutral-400" data-testid="empty-state">
        No projects yet. Create one from a brief, or import a repository.
      </p>
    </section>
  );
}
