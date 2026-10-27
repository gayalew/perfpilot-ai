import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, createProject, getProject, updateProject, type ProjectMode } from '../api.ts';
import { Button } from '../components/Button.tsx';
import { Card } from '../components/Card.tsx';
import { LoadGate } from '../components/QueryState.tsx';

const NAME = /^[A-Za-z0-9_.-]+$/;
const DAILY = '0 9 * * *';
const WEEKLY = '0 9 * * 1';

function badRoot(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) return true;
  return value.split(/[\\/]/).includes('..');
}

type Schedule = 'off' | 'daily' | 'weekly' | 'custom';

function scheduleFromCron(cron: string | null): Schedule {
  if (!cron) return 'off';
  if (cron === DAILY) return 'daily';
  if (cron === WEEKLY) return 'weekly';
  return 'custom';
}

function cronFromSchedule(schedule: Schedule, custom: string): string | null {
  if (schedule === 'off') return null;
  if (schedule === 'daily') return DAILY;
  if (schedule === 'weekly') return WEEKLY;
  return custom.trim() || null;
}

const fieldClass = 'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100';

export function ProjectFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const [loading, setLoading] = useState(editing);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverError, setServerError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ProjectMode>('url');
  const [url, setUrl] = useState('');
  const [repoOwner, setRepoOwner] = useState('');
  const [repoName, setRepoName] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [rootDir, setRootDir] = useState('');
  const [notifyEmail, setNotifyEmail] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [schedule, setSchedule] = useState<Schedule>('off');
  const [customCron, setCustomCron] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    getProject(id)
      .then((project) => {
        setName(project.name);
        setMode(project.mode);
        setUrl(project.url ?? '');
        setRepoOwner(project.repoOwner ?? '');
        setRepoName(project.repoName ?? '');
        setBaseBranch(project.baseBranch || 'main');
        setRootDir(project.rootDir ?? '');
        setNotifyEmail(project.notifyEmail ?? '');
        setTelegramChatId(project.telegramChatId ?? '');
        setSchedule(scheduleFromCron(project.scheduleCron));
        setCustomCron(project.scheduleCron && project.scheduleCron !== DAILY && project.scheduleCron !== WEEKLY ? project.scheduleCron : '');
      })
      .catch((caught: unknown) => setLoadError(caught instanceof Error ? caught.message : 'Could not load the project'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // The project id is the only input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function validate(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Name is required.';
    if (mode === 'url' && !url.trim()) next.url = 'URL is required.';
    if (mode === 'repo') {
      if (!repoOwner.trim() || !NAME.test(repoOwner.trim())) next.repoOwner = 'Owner may contain letters, numbers, dots, underscores, and dashes.';
      if (!repoName.trim() || !NAME.test(repoName.trim())) next.repoName = 'Repository name may contain letters, numbers, dots, underscores, and dashes.';
      if (!baseBranch.trim()) next.baseBranch = 'Base branch is required.';
      if (badRoot(rootDir.trim())) next.rootDir = 'Root directory must stay inside the repo.';
    }
    return next;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next = validate();
    setErrors(next);
    setServerError('');
    if (Object.keys(next).length) return;
    const body = {
      name: name.trim(),
      mode,
      url: mode === 'url' ? url.trim() : null,
      repoOwner: mode === 'repo' ? repoOwner.trim() : null,
      repoName: mode === 'repo' ? repoName.trim() : null,
      baseBranch: baseBranch.trim() || 'main',
      rootDir: rootDir.trim(),
      notifyEmail: notifyEmail.trim() || null,
      telegramChatId: telegramChatId.trim() || null,
      scheduleCron: cronFromSchedule(schedule, customCron),
    };
    setBusy(true);
    try {
      const saved = id ? await updateProject(id, body) : await createProject(body);
      navigate(`/projects/${saved.id}`);
    } catch (caught) {
      setServerError(caught instanceof ApiError ? caught.message : 'Could not save the project.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <LoadGate loading={loading} error={loadError} onRetry={load}>
      <div className="mb-4">
        <Link className="text-sm text-indigo-700 dark:text-indigo-300" to={id ? `/projects/${id}` : '/'}>{id ? 'Back to project' : 'Back to dashboard'}</Link>
        <h1 className="mt-2 text-2xl font-medium tracking-tight">{editing ? 'Edit project' : 'New project'}</h1>
      </div>
      <Card>
        <form onSubmit={onSubmit} className="space-y-5">
          <div>
            <label htmlFor="name" className="text-sm font-medium">Name</label>
            <input id="name" className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} />
            {errors.name && <p className="mt-1 text-sm text-red-700">{errors.name}</p>}
          </div>
          <fieldset>
            <legend className="text-sm font-medium">Mode</legend>
            <div className="mt-2 flex gap-2">
              {(['url', 'repo'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  className={`rounded-md px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 ${mode === value ? 'bg-indigo-600 text-white' : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100'}`}
                  onClick={() => setMode(value)}
                >
                  {value === 'url' ? 'URL' : 'Repo'}
                </button>
              ))}
            </div>
          </fieldset>
          {mode === 'url' ? (
            <div>
              <label htmlFor="url" className="text-sm font-medium">URL</label>
              <input id="url" className={fieldClass} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/" />
              {errors.url && <p className="mt-1 text-sm text-red-700">{errors.url}</p>}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="owner" className="text-sm font-medium">GitHub owner</label>
                <input id="owner" className={fieldClass} value={repoOwner} onChange={(event) => setRepoOwner(event.target.value)} />
                {errors.repoOwner && <p className="mt-1 text-sm text-red-700">{errors.repoOwner}</p>}
              </div>
              <div>
                <label htmlFor="repo" className="text-sm font-medium">Repository</label>
                <input id="repo" className={fieldClass} value={repoName} onChange={(event) => setRepoName(event.target.value)} />
                {errors.repoName && <p className="mt-1 text-sm text-red-700">{errors.repoName}</p>}
              </div>
              <div>
                <label htmlFor="branch" className="text-sm font-medium">Base branch</label>
                <input id="branch" className={fieldClass} value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} />
                {errors.baseBranch && <p className="mt-1 text-sm text-red-700">{errors.baseBranch}</p>}
              </div>
              <div>
                <label htmlFor="root" className="text-sm font-medium">Root directory</label>
                <input id="root" className={fieldClass} value={rootDir} onChange={(event) => setRootDir(event.target.value)} placeholder="demo-site" />
                <p className="mt-1 text-xs text-zinc-500">Folder inside the repo, empty for the root.</p>
                {errors.rootDir && <p className="mt-1 text-sm text-red-700">{errors.rootDir}</p>}
              </div>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="email" className="text-sm font-medium">Notification email</label>
              <input id="email" className={fieldClass} value={notifyEmail} onChange={(event) => setNotifyEmail(event.target.value)} />
              <p className="mt-1 text-xs text-zinc-500">Used by monitoring.</p>
            </div>
            <div>
              <label htmlFor="telegram" className="text-sm font-medium">Telegram chat id</label>
              <input id="telegram" className={fieldClass} value={telegramChatId} onChange={(event) => setTelegramChatId(event.target.value)} />
              <p className="mt-1 text-xs text-zinc-500">Used by monitoring.</p>
            </div>
          </div>
          <div>
            <label htmlFor="schedule" className="text-sm font-medium">Schedule</label>
            <select id="schedule" className={fieldClass} value={schedule} onChange={(event) => setSchedule(event.target.value as Schedule)}>
              <option value="off">Off</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="custom">Custom</option>
            </select>
            <p className="mt-1 text-xs text-zinc-500">Used by monitoring.</p>
            {schedule === 'custom' && (
              <input aria-label="Custom cron" className={`${fieldClass} mt-2`} value={customCron} onChange={(event) => setCustomCron(event.target.value)} placeholder="0 9 * * 1" />
            )}
          </div>
          {serverError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{serverError}</p>}
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save project'}</Button>
        </form>
      </Card>
    </LoadGate>
  );
}
