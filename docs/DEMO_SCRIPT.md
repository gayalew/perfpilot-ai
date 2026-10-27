# Demo script

About 9 minutes 30 seconds. Record the browser at 1280×720, zoom 100%. Speed up any stretch where Lighthouse is running and the timeline is not changing.

Have one finished optimize job ready. If the live run is still going when the live section ends, open that job instead. Say that it is an earlier run of the same project.

## Before recording

- `.env` is filled. `npm run demo:check` is all OK.
- `npm run db:migrate --workspace server` and `npm run seed --workspace server` have been run.
- `npm start --workspace demo-site` is serving http://localhost:4200 with `DEMO_REGRESSION` unset.
- `npx playwright install chromium` has been run. `npm run dev` is up. http://localhost:5173 loads.
- One optimize job on **Demo site (repo mode)** has already finished, with a pull request and a PDF, in case the live run overruns.
- **Send test notification** on that project has returned email `sent` and Telegram `sent`.
- The URL project you will monitor already has at least three `ok` or `learning` checks, so the next check is not still learning. If you need a clean chart, `npm run demo:reset -- --confirm` and then run three checks before you record.
- Close other browsers, editors doing work, and sync tools so the lab numbers stay still.
- Sign in before you hit record.

## 0:00 Problem (1:00)

| Time | On screen | Do this | Say | Result |
| --- | --- | --- | --- | --- |
| 0:00 | Dashboard | Open http://localhost:5173 | "A slow page is a product bug. Guessing which change helped is how performance work gets reverted." | Project cards are visible, including the demo repo and the demo URL. |
| 0:20 | Demo site | Open http://localhost:4200 | "This cafe page is the sample. It is slow on purpose: large images, blocking scripts, layout shift." | The cafe page is on screen. |
| 0:40 | Dashboard | Return to the dashboard | "PerfPilot measures, tries one fix at a time, and keeps it only when a statistical test says the page got better." | The dashboard is back. |

## 1:00 Design (2:00)

| Time | On screen | Do this | Say | Result |
| --- | --- | --- | --- | --- |
| 1:00 | `docs/ARCHITECTURE.md` or the README diagram | Scroll the architecture section | "The browser talks to an Express API. The API owns Postgres and starts one worker. The worker drives Lighthouse. Gemini plans. GitHub receives a pull request, never a merge." | The diagram or the component table is readable. |
| 1:40 | `docs/STATISTICS.md` | Show the 4-runs paragraph and the harm ceilings | "Four runs a side is the smallest sample that can reach p under 0.05. A score regression always blocks. LCP, TBT, and CLS block when they leave the good range or get more than 10% worse." | Those two paragraphs are on screen. |
| 2:20 | Project page, monitoring card | Open **Demo site (URL mode)** and point at Monitoring | "After a few healthy checks, two bad checks in a row open one incident and send one alert. The next healthy check sends recovery." | The monitoring card and trend, or the empty state, are visible. |

## 3:00 Live demo (4:30)

| Time | On screen | Do this | Say | Result |
| --- | --- | --- | --- | --- |
| 3:00 | Dashboard | Click **Demo site (repo mode)** | "Repo mode can edit the project. URL mode cannot." | The project page opens. Optimize is enabled. Experiment is disabled. |
| 3:15 | Run card | Choose **Optimize**. Set runs to 4. Check three fixes: Defer render-blocking scripts, Minify JavaScript and CSS, Resize and recompress images. Leave the others clear. | "Three fixes, four runs a side. The card shows the estimate. I will speed past the waiting." | The line reads about 14 minutes for 3 fixes. |
| 3:35 | Job page | Click **Start** | "Each fix is applied, then build, smoke, visual, and a paired Lighthouse test." | Status is queued or running. The timeline shows job-start, then a step. |
| 4:30 | Same job, sped up | Let it run, or cut to the prepared finished job | "Kept means every gate passed. Reverted means the sandbox was reset, so a failed idea is not in the pull request." | Steps show kept, reverted, or skipped, with the performance comparison. |
| 6:00 | GitHub pull request | Click the pull request link on the job | "The branch was pushed and this pull request was opened. The base branch was not merged." | The GitHub pull request page. |
| 6:25 | Phone or mail client, then the PDF link | Show the Telegram message and the email, then open the PDF from the job page | "The same result goes to Telegram and email, with the PDF attached when it was written." | A message naming the project, and the PDF download. |
| 6:50 | URL project | Open the prepared URL project. Point at the trend. | "These are real lab checks, not a drawn chart." | Score and LCP charts are visible. |
| 7:10 | Terminal, then the project | Stop the demo site. Start it with `DEMO_REGRESSION=1`. Click **Run check now** (runs 5). After it finishes as a breach, click **Run check now** again. | "The first bad check is a breach and stays quiet. The second opens the incident and sends one alert." | First job status `breach` and no new alert. Second job status `regression`, incident open, email and Telegram sent. |
| 7:40 | Same project | Stop the demo site, start it without `DEMO_REGRESSION`, click **Run check now** | "A healthy check closes the incident and sends recovery. It does not open a second alert." | Incident closed. One recovery message. |

If a check is still `learning`, you do not yet have three earlier healthy rows. Do not claim an alert that did not send.

## 7:30 Code walkthrough (2:00)

| Time | On screen | Do this | Say | Result |
| --- | --- | --- | --- | --- |
| 7:30 | `worker/src/measure.ts`, `measureInterleaved` | Show the loop that runs A then B | "Each pair is baseline then candidate, so a noisy minute hits both sides." | The `for` loop is visible. |
| 8:00 | `worker/src/stats.ts`, `mannWhitneyU` and `compareSamples` | Show the exact-permutation branch and the `p < alpha` check | "Small samples use every rank split. The effect also has to clear the noise floor." | `EXACT_LIMIT` and the `bigEnough` check. |
| 8:30 | `worker/src/optimize.ts`, `judgePerformance` | Show `CWV_GOOD` and the keep condition | "The test says whether it moved. This function says whether that move is harm." | `passed = improved && harms.length === 0`. |
| 9:00 | `server/src/executor.ts` | Show stdin spec and stdout `job-end` | "The API never imports Lighthouse. It supervises one child and stores the events." | `spawnJob` and `onStdout`. |

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `demo:check` is red | Read the FAIL line. It names the check, not the secret. Fix that setup and run it again. |
| Login 401 | The password in the form does not match `ADMIN_PASSWORD`. |
| Optimize stays disabled | You are on a URL project. Open **Demo site (repo mode)**. |
| Start returns 400 about runs | Runs per side is under 4. Set the slider to 4. |
| The run is still going at 6:00 | Open the prepared job. Say it is an earlier run of this project. |
| No pull request | No step was kept. Show the reverted reasons on the prepared job, or the `reason` on `job-end`. |
| No email or Telegram | `NOTIFY_DRY_RUN` is `1`, or a key is missing. The job still succeeds. Notification rows show `skipped`, `dry-run`, or `failed`. |
| Checks stay on learning | Fewer than three earlier healthy checks. Run more checks, or skip the alert beat. |
| Breach never becomes regression | `DEMO_REGRESSION` was not `1` when that server process started, or the move was inside the harm rules. Restart the demo site and show the comparison table. |
| Port 8080 or 5173 is busy | Stop the old process and run `npm run dev` again. |

## Field data, URL experiments, and Actions

These times were measured on this machine on 27 October 2026. Lighthouse time moves with the machine.

### Field data — about 35 seconds

1. Open a URL project for `https://web.dev/` (or create one). Click **Refresh field data**.
2. Wait about 35 seconds. The job succeeds without running Lighthouse locally. PageSpeed Insights and the Chrome UX Report are one request each.
3. The project page shows the field card: PageSpeed score, LCP, TBT, and CLS beside CrUX p75 for LCP, CLS, and INP, each with a good / needs-improvement / poor rating and the user histogram.
4. An origin with no Chrome UX Report, such as `http://localhost:4200/` or `https://httpstat.us/`, still succeeds. The card lists `No Chrome UX Report data for this origin` and, when Google cannot load the URL, `PageSpeed Insights HTTP 400`.

### URL experiments — about 6 minutes for two fixes

1. Open **Demo site (URL mode)** with the demo site running and `DEMO_REGRESSION` unset. Choose **Experiment**. Set runs to 4 and max steps to 2. Check **Defer render-blocking scripts** and **Lazy-load below-the-fold images**. Click **Start**.
2. The plan appears after the first Lighthouse pass, about one minute. Then each fix is measured as interleaved pairs: raw page, proxied page, four times.
3. Measured wall clock from Start to the result card: **5 minutes 50 seconds** (job `60521ffc-8f70-452c-bd95-271cb802da6a`). Lazy-load was kept (score median 35 to 57, LCP 30.7 s to 9.6 s, p = 0.014). Defer-scripts was reverted (LCP and TBT regressed, p = 0.014).
4. The result card says `1 proven runtime improvements`. The PDF is on the job. Email and Telegram are one `sent` row each, with the PDF attached. The demo site's files are unchanged.
5. Cancel mid-run takes effect within a few seconds. On this machine the extra Chrome and Node processes were gone 4 seconds after cancel (job `51d1c4d8-998c-43c7-b87a-3e193c0ce007`). The 90-minute timeout uses the same process-tree kill. It was not left running for 90 minutes.

`https://example.com/` with runs 4 and max steps 1 took **39 seconds** (job `551e4db2-14bb-49fb-8dd8-f5de7b5f2e7d`). The only planned step was cache headers, which the proxy cannot test, so it was skipped with `needs a repository`. No proxied measurement ran. Email and Telegram were still sent once each.

### GitHub Actions

A GitHub-hosted runner cannot call `http://localhost:8080`. The callback URL has to be public (`PERFPILOT_URL`, or a tunnel used only for the test). The workflow file in this repo sets read-only contents permission, a per-job concurrency group, a 90-minute timeout, and a one-day artifact. Those workflow edits run on GitHub only after they are pushed to the branch Actions uses. This machine did not have `gh`, `cloudflared`, or `ngrok`, so a live Actions run was not started from here.
