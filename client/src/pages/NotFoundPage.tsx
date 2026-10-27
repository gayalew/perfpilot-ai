import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="py-16">
      <h1 className="text-2xl font-medium">Page not found</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">That address is not part of PerfPilot.</p>
      <Link className="mt-4 inline-block text-sm text-indigo-700 underline dark:text-indigo-300" to="/">Back to the dashboard</Link>
    </div>
  );
}
