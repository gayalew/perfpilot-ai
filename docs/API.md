# HTTP API

Base URL `http://localhost:8080`. The client calls the same paths on port 5173; Vite proxies `/api`.

JSON field names are camelCase. Errors are `{ "error": "<message>" }`. A Zod failure is 400 and the message is the issues joined with `; `. An unexpected exception is 500 and `error` is the exception message.

## Auth

| Route | Auth |
| --- | --- |
| `GET /api/health`, `POST /api/login` | none |
| `POST /api/internal/run-due`, `GET /api/internal/jobs/:id/spec`, `POST /api/internal/jobs/:id/events` | header `x-job-secret`, compared with `JOB_SECRET`. Empty secret is 401 `{ "error": "unauthorized" }` |
| everything else under `/api` | cookie `pp_session`. Missing or bad cookie is 401 `{ "error": "authentication required" }` |

The cookie is HttpOnly, path `/`, 12 hours. `SameSite` is `lax`, or `none` when `COOKIE_SAMESITE=none`. `Secure` is set in production or when `SameSite` is `none`.

Login allows 5 failures per IP per 15 minutes, then 429 `{ "error": "too many attempts" }`. `run-due` allows 30 requests per IP per 60 seconds and counts every request, including a successful one.

## Endpoints

### `GET /api/health`

Auth: none. Response 200 `{ "ok": true }`.

### `POST /api/login`

Auth: none. Body `{ "password": string }`. 200 `{ "ok": true }` and `Set-Cookie`. 401 `{ "error": "invalid password" }`.

### `POST /api/logout`

Auth: cookie. Clears the cookie. 200 `{ "ok": true }`.

### `GET /api/me`

Auth: cookie. 200 `{ "ok": true }`.

### `POST /api/internal/run-due`

Auth: `x-job-secret`. Enqueues monitor jobs that are due and returns 200 `{ "enqueued": ["<job id>", ...] }`. 401 as above. 429 `{ "error": "too many attempts" }`.

### `GET /api/internal/jobs/:id/spec`

Auth: `x-job-secret`. 200 is the worker spec: `jobId`, `type`, `runs`, `maxSteps`, `useAi`, `onlyFixes` (omitted when unset), `runDir`, `project` (`mode`, `url`, `repoOwner`, `repoName`, `baseBranch`, `rootDir`). 404 `{ "error": "job not found" }` when the job, project, or Actions handler is missing.

### `POST /api/internal/jobs/:id/events`

Auth: `x-job-secret`. Body `{ "type": string, "payload": object }`. `type` is required (400 `{ "error": "type is required" }`). 200 `{ "ok": true, "result": "ok" | "closed" }`. `closed` means the job was already `succeeded`, `failed`, or `cancelled` and the event was ignored. 404 when the job or the Actions handler is missing. `actions-run` with a positive integer `payload.runId` is remembered for cancel.

### `GET /api/projects`

Auth: cookie. 200 array of projects: `id`, `name`, `mode`, `url`, `repoOwner`, `repoName`, `baseBranch`, `rootDir`, `notifyEmail`, `telegramChatId`, `scheduleCron`, `createdAt`.

### `POST /api/projects`

Auth: cookie. Body: `name`, `mode` (`url` or `repo`), and for `url` a `url`; for `repo` a `repoOwner` and `repoName` matching `^[A-Za-z0-9_.-]+$`. Optional: `baseBranch`, `rootDir` (must stay inside the repo), `notifyEmail`, `telegramChatId`, `scheduleCron` (a cron expression). Snake_case aliases are accepted. 201 the project. 400 on validation.

### `GET /api/projects/:id`

Auth: cookie. 200 the project. 404 `{ "error": "project not found" }`.

### `PATCH /api/projects/:id`

Auth: cookie. Body: any project fields. 200 the updated project. 404 when missing. 400 on validation.

### `DELETE /api/projects/:id`

Auth: cookie. 204 empty. 404 when missing. Jobs and measurements cascade in the database.

### `POST /api/projects/:id/jobs`

Auth: cookie. Body:

```json
{ "type": "audit|optimize|monitor|experiment|field", "runs": 4, "maxSteps": 8, "useAi": true, "onlyFixes": ["defer-scripts"] }
```

`runs` is 4–10, except monitor which is 3–10. `field` does not check `runs`. Omitted `runs` becomes 5 for monitor, 1 for field, and 4 otherwise. `maxSteps` is 1–12, default 12. `useAi` defaults to true. `onlyFixes` is optional, at most 12 strings.

400 `{ "error": "optimize requires a repo project" }`, `{ "error": "experiment requires a URL project" }`, or `{ "error": "the project needs a URL" }` when an experiment or field project has no URL. 202 `{ "id": "<job id>" }`. 404 when the project is missing.

### `GET /api/projects/:id/measurements?limit=40`

Auth: cookie. `limit` 1–100, default 40. 200 the last N measurement rows that have `samples`. 400 `{ "error": "limit must be between 1 and 100" }`.

### `GET /api/projects/:id/field`

Auth: cookie. 200 the latest `profile: "field"` report object, or `null`.

### `GET /api/projects/:id/incidents`

Auth: cookie. 200 incident rows for the project.

### `GET /api/projects/:id/jobs`

Auth: cookie. 200 jobs for the project. An unknown id returns an empty array.

### `GET /api/projects/:id/summary`

Auth: cookie. 200:

```json
{
  "lastJob": {},
  "lastSucceededOptimize": {},
  "lastPrUrl": null,
  "jobCount": 0,
  "monitor": {
    "latestStatus": null,
    "baselineCount": 0,
    "incidentOpen": false,
    "lastCheck": null,
    "minHistory": 3
  }
}
```

`lastJob` and `lastSucceededOptimize` are job objects or null.

### `GET /api/jobs?limit=20`

Auth: cookie. `limit` 1–100, default 20. 200 recent jobs, including `projectName` when the store joined it.

### `GET /api/jobs/:id`

Auth: cookie. 200 the job: `id`, `projectId`, `type`, `status`, `params`, `result`, `prUrl`, `error`, `createdAt`, `startedAt`, `finishedAt`. 404 `{ "error": "job not found" }`.

### `POST /api/jobs/:id/cancel`

Auth: cookie. 200 the job after cancel. 409 `{ "error": "job is <status>" }` unless status is `queued` or `running`. 404 when missing.

### `GET /api/jobs/:id/events`

Auth: cookie. Server-Sent Events (`text/event-stream`). Each stored event is:

```
id: <event id>
data: {"type":"<type>","payload":{}}

```

`Last-Event-ID` skips earlier ids. A comment heartbeat `: heartbeat` is sent every 15 seconds while the job is open. The response ends after a stored or live `job-end`, or when the job is already `succeeded`, `failed`, or `cancelled`.

### `GET /api/jobs/:id/ledger`

Auth: cookie. 200 `result.ledger`. 404 `{ "error": "ledger not ready" }` or job not found.

### `GET /api/jobs/:id/report.pdf`

Auth: cookie. 200 `application/pdf` as an attachment named `perfpilot-report.pdf`, streamed from `runs/<job id>/report.pdf`. 404 `{ "error": "report not found" }`.

### `GET /api/jobs/:id/summary.md`

Auth: cookie. 200 `text/markdown`, the `result.summary` string. 404 `{ "error": "summary not ready" }`.

### `GET /api/jobs/:id/notifications`

Auth: cookie. 200 notification rows: `id`, `projectId`, `jobId`, `channel`, `kind`, `status`, `error`, `createdAt`.

### `POST /api/projects/:id/notify-test`

Auth: cookie. Sends a test email and a test Telegram message for that project. 200 `{ "email": { "status", "error?" }, "telegram": { "status", "error?" } }`. `status` is `sent`, `failed`, `dry-run`, or `skipped`. When notifications are not wired, both are `skipped` with `error` `notifications are not configured`.

Event `type` and `payload` keys are listed in [ARCHITECTURE.md](ARCHITECTURE.md).
