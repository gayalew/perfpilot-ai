import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, login } from '../api.ts';
import { Button } from '../components/Button.tsx';

export function LoginPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(password);
      navigate('/');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) setError('Too many attempts. Wait a few minutes, then try again.');
      else if (caught instanceof ApiError && caught.status === 401) setError('That password is not right.');
      else setError(caught instanceof Error ? caught.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100 px-4 dark:bg-zinc-950">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-xl bg-white p-6 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
        <h1 className="text-2xl font-medium tracking-tight text-zinc-900 dark:text-zinc-100">PerfPilot</h1>
        <p className="mt-1 text-sm text-zinc-500">Sign in to the engineering dashboard.</p>
        <label htmlFor="password" className="mt-6 block text-sm font-medium text-zinc-700 dark:text-zinc-200">Password</label>
        <input
          id="password"
          data-testid="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
        {error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
        <Button className="mt-5 w-full" type="submit" disabled={busy} data-testid="login-submit">{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </div>
  );
}
