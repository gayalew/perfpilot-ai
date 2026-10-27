import type { ReactNode } from 'react';
import { safeGithubUrl } from '../format.ts';

export function GithubLink({ url, children }: { url: string | null | undefined; children: ReactNode }) {
  const href = safeGithubUrl(url);
  if (!href) return null;
  return (
    <a className="text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
