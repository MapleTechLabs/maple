# Foldkit migration: brief for every porting agent

Read first, in order: `CLAUDE.md`, `docs/foldkit-migration.md`, `docs/foldkit-decisions/*.md`
(S1's porting method and gotchas are binding), `packages/ui-parity/README.md`. Foldkit 0.168 is
cloned at `~/scratch/foldkit`: read `AGENTS.md`, `skills/foldkit`, and the pages under
`packages/website/src/page/` for what you use (Mount, Subscription, Submodel, Command, testing).
Hazel's finished Foldkit app is a working reference: `~/Documents/GitHub/hazel/apps/web-foldkit/src`,
and its review findings are mistakes to avoid: `~/Documents/GitHub/hazel/docs/foldkit-review/2026-10-full-audit.md`.

## Acceptance

- A screen is done when its parity scenarios are `identical` (or `pass` with 0 perceptual px,
  explained), with 0 behavior diffs, 0 unmocked calls and no console errors.
- Never edit the baseline, scenario expectations or tolerances to make a diff disappear. Fix the port.
- Port the class composition (the same `cn`/`cva` calls), not hand-copied output. If the class
  logic lives in a React file, copy the `cva`/class constant verbatim into
  `apps/web-foldkit/src/ui/` and mark it `// styles: packages/ui/src/<path>` so the styles
  extraction can dedupe it later.
- Scenario steps use accessible locators only (`getByRole`, `getByText`). A role or label missing
  in Foldkit is a port bug.
- Lab pages: `apps/web/src/lab/<x>.tsx` at `/lab/<x>` is ported as
  `apps/web-foldkit/src/lab/entries/<x>.ts` exporting `lab = defineLab(title, program)`
  (`src/lab/define.ts`). It is booted instead of the app, lazily.

## Foldkit rules

- Messages are past-tense facts (`ClickedRow`, `SucceededLoadLogs`), Commands verb-first, never `NoOp`.
- `init`, `update` and `view` are pure: no clock, locale, DOM or storage reads in them. Those are
  Commands or Flags.
- Imperative widgets (canvas charts, three, xyflow, editors) attach through `Mount`. Heavy
  libraries are `import()`ed inside the Mount or Command, never statically (S2: startup budget).
- Async results carry what they were for (org, request id) so stale results are dropped.
- In-flight guards in `update`, not only disabled buttons.
- No module-level mutable state.

## Repo rules

- Effect v4. Effect Schema, `Schema.TaggedError` with namespaced tags, no `Record<string, any>`,
  no inline casts, never try/catch, `Effect.forEach` not `for`/`while` in Effect code,
  `HttpClient` not `fetch`, branded ids from `@maple/domain`.
- Comments 1 to 3 lines. Never use em dashes in any text you write.
- Do not run `bun run test`, turbo, repo-wide typecheck or `bun dev`. Scoped commands only:
  `bun run --cwd apps/web-foldkit typecheck`, `cd apps/web-foldkit && bunx vitest run <file>`.
  Cap commands with the Bash timeout (150000 ms, builds and parity runs up to 500000) and
  `perl -e 'alarm 480; exec @ARGV' <cmd>`. At most about 60 lines per Edit or Write call.
- Use the `PARITY_PORT_BASE` you were given. Stop servers you start; never kill processes you did
  not start.
- Never `git stash`, never `git add -A` or `git commit -a`. Commit only when your brief says so.
- New dependencies: ask the orchestrator unless your brief allows adding them.

## Report

Commands run with results, parity totals and run folder, files changed, open issues, and any
change you need in files outside your scope.
