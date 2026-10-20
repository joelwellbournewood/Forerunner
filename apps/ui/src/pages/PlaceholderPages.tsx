import { Link } from "react-router";

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
