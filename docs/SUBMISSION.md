# Submission map

| Requirement | Where it is satisfied |
| --- | --- |
| Agent for a non-HR role | Frontend / DevOps performance engineer. The worker plans fixes, applies them, and keeps a change only after the gates. README, `worker/src/optimize.ts`, `worker/src/job-runner.ts`. |
| Full-stack web UI | React client: login, dashboard, project, job timeline, monitoring charts. Screens: `docs/screenshots/login.png`, `dashboard.png`, `project.png`, `project-monitoring.png`, `job-live.png`, `job-result.png`, `job-monitor.png`, `report-p1.png`. |
| Backend | Express API, Postgres, job executor, scheduler. `server/src/app.ts`, `server/src/executor.ts`, `server/migrations`. |
| At least two free third-party APIs | Google Gemini, GitHub REST, Resend, and Telegram Bot API. Neon hosts Postgres. See the list below. |
| Proactive actions | Cron monitor jobs (`server/src/scheduler.ts`), regression alert and recovery (`server/src/monitor/record.ts`), weekly digest, pull request when a fix is kept (`worker/src/job-runner.ts`). The tool does not merge. |
| Demo video: problem, design, live UI, code | Shot list in `docs/DEMO_SCRIPT.md`. |
| Source and docs | This repo. `README.md`, `docs/ARCHITECTURE.md`, `docs/STATISTICS.md`, `docs/API.md`, `docs/DEMO_SCRIPT.md`. |

## Third-party APIs

| API | What the code calls it for |
| --- | --- |
| Google Gemini | `worker/src/gemini.ts` plans fixes and edits files. The key is the `x-goog-api-key` header. |
| GitHub REST | `worker/src/job-runner.ts` opens a pull request. `server/src/actions.ts` dispatches and cancels a workflow when `EXECUTOR=github`. That executor is implemented and unit-tested, not yet run end to end on GitHub-hosted runners. `server/src/monitor/suspects.ts` lists commits. |
| Resend | `server/src/notify/send.ts` sends email. |
| Telegram Bot API | `server/src/notify/send.ts` sends the same notifications. |
| Neon Postgres | `DATABASE_URL`. The server uses `pg`. Neon is the database, not an application API. |
| PageSpeed Insights and Chrome UX Report | `worker/src/field.ts`, when `GOOGLE_API_KEY` is set. |

Google Gemini, GitHub, Resend, and Telegram are the four product APIs. Any two of them meet the assignment bar.
