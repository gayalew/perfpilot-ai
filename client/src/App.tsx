import { useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { ApiError, me } from './api.ts';
import { Shell } from './components/Shell.tsx';
import { ToastProvider } from './components/Toast.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { JobPage } from './pages/JobPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { ProjectFormPage } from './pages/ProjectFormPage.tsx';
import { ProjectPage } from './pages/ProjectPage.tsx';

function RequireAuth() {
  const location = useLocation();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let gone = false;
    me()
      .then(() => {
        if (!gone) setState('ready');
      })
      .catch((error: unknown) => {
        if (gone) return;
        if (error instanceof ApiError && error.status === 401) return;
        setMessage(error instanceof Error ? error.message : 'Could not reach PerfPilot');
        setState('error');
      });
    return () => {
      gone = true;
    };
  }, [location.pathname]);

  if (state === 'loading') return <div className="min-h-screen bg-zinc-100 dark:bg-zinc-950" />;
  if (state === 'error') {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <p role="alert" className="text-sm text-red-700">{message}</p>
        <button type="button" className="mt-3 text-sm text-indigo-700 underline" onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/projects/new" element={<ProjectFormPage />} />
        <Route path="/projects/:id/edit" element={<ProjectFormPage />} />
        <Route path="/projects/:id" element={<ProjectPage />} />
        <Route path="/jobs/:id" element={<JobPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<RequireAuth />} />
      </Routes>
    </ToastProvider>
  );
}
