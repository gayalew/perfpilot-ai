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
