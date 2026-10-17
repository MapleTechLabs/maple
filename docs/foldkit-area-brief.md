# Foldkit migration: porting one area

You port one product area of `apps/web` into `apps/web-foldkit`, in an isolated worktree, and
commit on your worktree branch. The orchestrator merges.

## Read first

`docs/foldkit-agent-brief.md` (rules, binding), `docs/foldkit-decisions/s8-pages.md` (the page
pattern: follow it exactly), the other decision records for what your area uses (s3 charts, s4
tables, s5 service map, s6 data, s7 overlays), and `packages/ui-parity/README.md`.
`apps/web-foldkit/src/page/services/` is the worked example.

## Setup

1. `git log --oneline -1` must be on `fk/parity-harness` (the brief names the minimum commit); if
   the worktree started on `main`, run `git reset --hard fk/parity-harness`.
2. `bun install --frozen-lockfile && bun run --cwd packages/effect-sdk build`.
3. Use only the `PARITY_PORT_BASE` you were given.

## Done means

- Every scenario of your area is `identical`, or `pass` at 0 perceptual px with the cause stated:
  `bun run --cwd packages/ui-parity parity run --baseline legacy-head --candidate foldkit --filter <terms>`
  (`parity list --filter <terms>` shows them; comma-separated terms work). 0 behavior diffs,
  0 unmocked calls, no console errors.
- Loading and error states: add `faults` scenarios (README "Timed and error states") for each page
  with data, and make them match.
- Scene tests for every page's update logic; `bun run --cwd apps/web-foldkit typecheck`;
  `cd apps/web-foldkit && bunx vitest run` all pass;
  `bunx oxlint -c .oxlintrc.effect.json --quiet apps/web-foldkit/src` clean.
- Pages register in `page/registry.ts` with one entry each (the only root file you touch).

## Shared code (other area agents work in parallel)

- Before adding to `src/ui/`, check it does not exist (`ls apps/web-foldkit/src/ui`, grep). Add a
  primitive to `src/ui/` only if it is a `@maple/ui` component; area components live under
  `page/<area>/`. Never fork an existing primitive: extend it with an option.
- Icons: add names to `apps/web-foldkit/scripts/generate-icons.tsx` and rerun it; never hand-write
  SVG. The orchestrator regenerates `icons.generated.ts` after merging.
- Data: `@maple/web-data` query functions through the WarehouseExecutor resource (s6). If a legacy
  module you need is React-coupled, extract its React-free part into `@maple/web-data` (neutral
  for legacy, prove with `parity run --baseline legacy --candidate legacy-head --filter <area>`).
- Fixtures: if a legacy scenario of your area is unhealthy or missing a state, fix it in
  `packages/ui-parity/src/fixtures/areas/<area>.ts` and `src/scenarios/<area>.ts`.
- Do not change `apps/web` behavior. Never edit the baseline, tolerances or scenario expectations
  to hide a diff.

## Limits

- One parity run at a time, filtered to your area. Commands capped with the Bash timeout and
  `perl -e 'alarm 480; exec @ARGV' <cmd>`; at most about 60 lines per Edit or Write.
- Commit in logical units on your worktree branch, explicit paths, no Co-Authored-By trailer,
  never `git add -A`, never stash.

## Report

Branch and SHAs, a parity table per scenario, primitives you added to `src/ui`, files touched
outside `page/<area>/`, and anything not ported with the reason.
