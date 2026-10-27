# PerfPilot AI

An autonomous web performance engineer: measure, diagnose, fix, re-measure, keep only proven improvements.

## Phase 1: measurement engine

```
npm install
npx playwright install chromium          # one time, gives Lighthouse a browser
npm test                                 # 24 unit tests

# try it on the built-in fixture (slow page vs fast page)
node worker/fixtures/server.mjs &        # serves /slow and /fast on port 4173
npx tsx worker/src/cli.ts measure http://localhost:4173/slow --runs 5
npx tsx worker/src/cli.ts ab http://localhost:4173/slow http://localhost:4173/fast --runs 5
```

Commands: `measure <url>`, `ab <baselineUrl> <candidateUrl>` (interleaved runs), `compare a.json b.json`.
Options: `--runs 3..25`, `--profile mobile|slow-mobile|desktop`, `--out file.json`, `--json`.
Set `PERFPILOT_CHROME` to point at a specific Chrome/Chromium binary.

How a change is judged: runs are interleaved, compared per metric with a one-sided Mann-Whitney U test,
and must also exceed a minimum effect size and the baseline's run-to-run noise.

Never commit `.env`. See `.env.example`.

## Optimize

```
npx tsx --env-file=.env worker/src/cli.ts optimize demo-site --runs 4 --final-runs 5
npx tsx --env-file=.env worker/src/cli.ts optimize demo-site --runs 4 --final-runs 5 --no-ai
```

`optimize <repoPath>` copies the site into `runs/<id>/work`, tries one planned fix at a time on a local branch, and keeps the change only when every gate passes:

1. **build** — `buildCommand` exits 0, or there is nothing to build.
2. **smoke** — each configured path and its same-origin assets respond, and the page does not add console errors.
3. **visual** — screenshots at 390×844 and 1350×940 stay within a small pixel difference.
4. **performance** — interleaved Lighthouse runs (`--runs`, default 4) must come back `improved`. An unchanged result is not enough.

A passing fix is committed in the sandbox copy. A failing fix is reset. Nothing is merged or pushed. `--no-ai` skips model edits (`needs AI`) and still applies the deterministic fixes. The run writes `ledger.json`, `events.jsonl`, and `summary.md`. Exit code is 0 when the run finishes, including when some fixes were reverted.

A repo can supply `perfpilot.config.json` (`startCommand`, `port`, `paths`, `publicDir`, `serverFile`, and optional install/build commands).
