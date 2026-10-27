import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger';

const styles: Record<Variant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500',
  ghost: 'bg-white text-zinc-800 ring-1 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-800',
  danger: 'bg-red-600 text-white hover:bg-red-500',
};

const shape = 'inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50';

export function Button({ variant = 'primary', className = '', type = 'button', href, target, rel, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; href?: string; target?: string; rel?: string; children?: ReactNode }) {
  const classNames = `${shape} ${styles[variant]} ${className}`;
  if (href) return <a className={classNames} href={href} target={target} rel={rel}>{children}</a>;
  return (
    <button type={type} className={classNames} {...props}>
      {children}
    </button>
  );
}
