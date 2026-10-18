# @maple/ui-parity

Pixel and behavior comparison of the legacy React frontend (`apps/web`) against the Foldkit
frontend (`apps/web-foldkit`). It is the acceptance test for the migration
(`docs/foldkit-migration.md` §3): a screen counts as ported when its scenarios come back `identical`.

There is no root script. Run everything from the repo root with:

```bash
bun run --cwd packages/ui-parity parity <command>
```

```bash
parity build legacy           # apps/web at LEGACY_BASELINE_REF (src/config.ts), in a pinned worktree
parity build legacy-head      # apps/web from the working tree
parity build foldkit          # apps/web-foldkit from the working tree
parity run                    # capture legacy and foldkit, diff, write the report
```

## Targets and builds

| Target        | Source                                                                                         | `serve` port |
| ------------- | ---------------------------------------------------------------------------------------------- | ------------ |
| `legacy`      | `apps/web` at `LEGACY_BASELINE_REF`, detached worktree in `~/.cache/maple-ui-parity/worktrees` | base + 1     |
| `foldkit`     | `apps/web-foldkit` (working tree)                                                              | base + 2     |
| `legacy-head` | `apps/web` (working tree)                                                                      | base + 4     |

- The pinned worktree is created on first use: `git worktree add --detach`, `bun install --frozen-lockfile`,
  `bun run --cwd packages/effect-sdk build`. A `.parity-setup-done` marker makes a half-done setup retry.
- Builds are production `vite build`s with every URL pointed at the fixture backend (`buildEnv` in
  `src/config.ts`): `VITE_API_BASE_URL`, `VITE_API_PUBLIC_URL`, `VITE_INGEST_URL`,
  `VITE_MAPLE_SELF_INGEST_URL` = backend origin, `VITE_ELECTRIC_SYNC_URL` = Electric origin,
  `VITE_MAPLE_REPLAY=off`, `VITE_MAPLE_CAPTURE=off`, a fake `pk_test` Clerk key.
- Vite runs with a wrapper config (`src/runtime/vite-wrapper.ts`, written to the app's
  `node_modules/.parity/`). It points `envDir` at an empty directory so no `.env*` file leaks in, and
  adds the lab-gate plugin (below). `PORTLESS_URL`, `VITE_COMMIT_SHA`, `VITE_MCP_URL` and
  `VITE_MAPLE_REGION_APP_URLS` are stripped from the environment.
- **Auth flavors.** `--auth self_hosted` (default) or `--auth clerk` builds with that
  `VITE_MAPLE_AUTH_MODE`; the Clerk flavor lands in `<build>--clerk/`. A capture picks the flavor from
  its dataset's `auth`. Scenarios on a Clerk dataset need that flavor: `run`, `selfcheck` and
  `capture` build a missing one first from the self-hosted build's stamp (same target, same pinned
  ref; working-tree targets from the tree as it is then). An existing Clerk flavor is not rebuilt,
  so after changing the app run `parity build <target> --auth clerk` yourself.
- **Custom outputs.** `--out <name>` builds into `.parity/builds/<name>/`, and every command that takes
  a build (`run --baseline/--candidate`, `selfcheck --target`, `capture`) accepts that name. Use it to
  compare a working-tree change against a clean build of the same target.

### The `/lab` gate

`apps/web/src/routes/lab/route.tsx` throws `notFound()` unless `import.meta.env.DEV`. Parity builds are
production builds, so the wrapper config adds a `pre` transform that rewrites `import.meta.env.DEV`
to `true` in that one file only. A global `DEV` define would also switch on the dev-only banners, the
lab dials panel and the service map's layout debug overlay. No `apps/web` source changes.

## How a capture works

- **One origin.** Every build is loaded through `http://localhost:4800`, fulfilled inside Playwright
  straight from the build directory (nothing binds it), so anything printing `location.origin` matches
  across builds and port bases. Requests to any other origin than the fixture backend are aborted and
  listed as `blockedRequests`.
- **Ports.** Offsets from `PARITY_PORT_BASE` (default 4790): backend `+0`, legacy `+1`, foldkit `+2`,
  Electric `+3`, legacy-head `+4`. Give each worktree its own base (`PARITY_PORT_BASE=4900`). Bases that
  reach a port Chromium refuses (or 5000/7000, macOS AirPlay) are rejected. Builds embed the backend
  URLs, so a non-default base builds into `.parity/builds-<base>/` and a build made for another base is refused.
- **Fixture backend.** `src/backend/index.ts` exports `startBackend` (the seam is `src/contract.ts`).
  Every request to it carries `x-parity-dataset` (the scenario's dataset) and `x-parity-capture`
  (`<label>/<variant>`), so the backend can attribute calls. Until the module exists the harness runs
  with a **null backend**: API and Electric requests are answered 404 and listed as `unmocked`, which is
  reported but does not fail a variant, so the backend-free `/lab` scenarios still work
  (`PARITY_NULL_BACKEND=1` forces this mode even when the backend exists). Scenarios that
  name a dataset fail with "needs the fixture backend". With a real backend, any unmocked request fails
  the variant.
- **Auth.** `self_hosted` datasets get the token in **sessionStorage** `maple.self_hosted.token`
  (`apps/web/src/lib/services/common/self-hosted-auth.ts`). The token (`selfHostedTokenFor` in
  `src/runtime/session.ts`) is an unsigned JWT carrying the dataset's `org_id`, which
  `src/backend/auth.ts` checks, with `exp` 30 days past the frozen clock so the app never renews it. `clerk` datasets get `window.Clerk` from
  `src/runtime/clerk-stub.ts`: `@clerk/clerk-react` 5 finds it loaded, never downloads clerk-js, and
  hydrates `useAuth` / `useUser` / `useOrganization` from its `addListener` emit. Members the app reads
  that the stub lacks are recorded per capture as `clerkUnknown`.
- **Theme.** localStorage `maple-theme` = `light` | `dark` (the pre-paint script in `apps/web/index.html`
  and `@maple/ui/hooks/use-theme`), plus Playwright's `colorScheme`.
- **Determinism** (`src/runtime/stabilize.ts`). Frozen clock (`dataset.now`, or `NO_DATASET_NOW` without
  a dataset), UTC, en-US, `deviceScaleFactor: 1`, `reducedMotion`, seeded `Math.random`, intervals
  clamped to one per frame, CSS animations and transitions frozen at their end state, infinite Web
  Animations paused after their first iteration, SMIL at t=0, carets and scrollbars hidden, service
  workers blocked. A capture waits for fonts and every image to decode, then 400ms without DOM
  mutations, then two consecutive frames in which no scroll offset, scroll extent, image or **canvas
  pixel hash** changes (charts draw on `<canvas>`). Then the screenshot is retaken until two in a row
  are byte-identical. Full-page captures (`fullPage`, default true) first grow the viewport until no
  page-sized inner scroller overflows (`h-screen` layouts scroll a container, not the document), up
  to 12,000 px, settling after each step. WebGL canvases without `preserveDrawingBuffer` read back blank, so only their
  layout counts.
- **Healthy captures only.** A capture that crashes, fails a step, logs console errors, or (with a real
  backend) hits an unmocked endpoint fails its variant even when the pixels match.
- **Behavior.** The call log as of the screenshot (`FixtureBackend.takeCalls`) is stored in
  `<variant>.json` as `calls` and diffed as a multiset per tag (`src/behavior.ts`): order ignored, keys
  sorted, v4 UUIDs replaced by `<random-uuid>`. Any difference fails the variant. `Scenario.pageCalls`
  lists tag prefixes (`warehouse:`, `shape:alert_`) left out of the diff while a shell scenario's page
  is still a placeholder; the shell's own calls still count.
- **Accessibility.** `body` ARIA snapshots are diffed as multisets of lines and reported in an
  "a11y deltas" section. Report-only unless `--strict-a11y`.
- **Two kinds of diff** (`src/compare.ts`). Pixels: strict (any channel) and perceptual (pixelmatch,
  anti-aliasing ignored), clustered into regions. Structure: every visible text run and control with
  its box and the computed styles that decide its look, matched by text or role + name (never DOM
  shape). Identical style changes are grouped into root causes, e.g.
  `{padding-left: 16px → 12px} on 9: button "Save" | ...`, then knock-on moves.

## Workflows

### Freeze the baseline

```bash
parity build legacy [--ref <sha>]
parity selfcheck --target legacy        # must print "All N variants deterministic."
```

Run `selfcheck` again after adding scenarios. A flaky scenario cannot tell you whether a port is correct.

### Port loop

```bash
parity build foldkit && parity run --filter lab-infra
```

1. Read `.parity/runs/<run>/summary.md`: worst variants first, root-cause style groups, moves, then
   elements missing from or extra in the candidate.
2. Fix the Foldkit view and repeat until the variant is `identical`.
3. Open `index.html` in the same run folder for swipe, onion skin, blink, side-by-side and diff
   (keys `1`-`5`, `j`/`k` to step). Click a red region to highlight the elements responsible.

`parity compare --run <run>` re-diffs captures without capturing again. `--filter` takes
comma-separated terms; a variant matches when any term equals its area (`lab`, `routes`) or is a
substring of its id (`lab-infra--desktop--dark`): `--filter route,lab,kit`. The exit code is
non-zero on any `fail` or `missing`.

### Check that the harness sees a change

```bash
parity build legacy-head                           # clean
# edit a class in packages/ui, then:
parity build legacy-head --out legacy-head-edit
parity run --baseline legacy-head --candidate legacy-head-edit --filter lab
# revert the edit
```

### Reference markup

Every capture writes `<variant>.html`, the rendered DOM with sorted attributes.
`parity codegen <file.html> --line 120 --name header` turns a subtree into Foldkit `h(...)` code with
class strings kept verbatim.

### Side-by-side browsing

`parity serve [--dataset default]` starts the fixture backend and serves every built target on its
port, signed in as the dataset's user. The clock is not frozen there.

### Coverage

`parity coverage` lists every route in `apps/web/src/routeTree.gen.ts` at `LEGACY_BASELINE_REF`
(read with `git show`, `/lab` excluded) with the scenarios that visit it. `parity list` prints every
scenario × viewport × theme variant with its dataset.

### Add a scenario

Add it to the area file `src/scenarios/<area>.ts` (an `AreaModule`) and list a new area in
`src/scenarios.ts`. Steps must use accessible locators (`getByRole`, `getByText`) so the same script
drives both apps; a step that works in one app and not the other is a parity bug. Datasets belong to
the fixture backend (`src/fixtures/`); a scenario names one by `dataset`.

Scenario options beyond `path`, `dataset` and `steps` (`src/scenarios/types.ts`):

- `targets`: the targets the screen exists in. `run`, `selfcheck` and `capture` skip the scenario
  unless every build they capture is one of them (`data-probe` is `["foldkit"]`).
- `faults` and `settle`: timed and error states, below.
- `pageCalls`, `fullPage`, `mask`, `viewports`, `themes`.

Two areas are generated rather than listed:

- `lab`: every `session: "none"` entry of `apps/web/src/lab/registry.ts` plus `/lab`, parsed from the
  registry source so new lab pages are picked up, desktop, light and dark, signed in on dataset
  `default` (the root shell calls the API on lab pages too). `lab-canvas.ts` adds interaction states.
- `routes`: core app routes on dataset `default`, `/sign-in` on `signed-out`, and the session-only
  `/lab/query-builder`. They pass once the fixture backend serves those datasets.

### Fixture areas

Each product area's fixtures live in `src/fixtures/areas/<area>.ts` exporting `fixtureArea`
(`src/fixtures/areas.ts`), discovered at startup like the scenario areas, so parallel work never edits
a shared file: built-in endpoint answers for every dataset (a dataset's own `endpoints` still win),
rows appended to the `default` dataset's Electric tables, extra datasets, and raw routes outside the
HttpApis (chat SSE). Two areas answering one endpoint is a startup error.

### Timed and error states

`Faults` (`src/contract.ts`) delay or fail HttpApi endpoints by tag prefix, the longest prefix
winning: `delays: { "queryEngine.executeBatch": 60_000 }` holds matching requests (after logging
them), `failures: { "queryEngine.executeBatch": { status: 502, body: { _tag, message } } }` answers
with that encoded error, which the app decodes when the endpoint declares it. A dataset's `faults`
apply to every scenario on it; `Scenario.faults` travel in the `x-parity-faults` header and override
them per prefix. Raw routes are matched by their tag (`chat.history`); a raw route's request body is part of its logged payload. Electric shapes are not covered.

- `settle: "held"` captures a loading state: before each settle point the capture waits until every
  request in flight to the API is one the backend is holding (`FixtureBackend.held`), then settles
  visually as usual. The default `"quiet"` would also work most of the time, but could screenshot
  while an unheld request is still arriving.
- Chromium's `Failed to load resource ... status of <n>` console line is expected for a status the
  scenario injects and does not fail the variant (scenario-level `failures` only).
- Examples: `services-loading` and `services-error` in `src/scenarios/services-page.ts`.

### Tests

`bun run test` runs the pure suites (call log, faults, behavior diff) and is what CI runs.
`bun run test:backend` starts the fixture backend (needs `~/.maple/bin/libchdb.so` and `apps/api`
installed) and checks every endpoint family; run it locally after backend or fixture changes.

## Output

`.parity/` (gitignored by its own `.gitignore`):

- `builds/<build>/`: static builds, with `.parity-build.json` (target, ref, base, auth mode)
- `runs/<run>/<label>/<variant>.png|.json|.html` and `_results.json`
- `runs/<run>/diff/`: pixelmatch diff images
- `runs/<run>/summary.md`, `summary.json`, `index.html`

## Known gaps

- Chromium only, and font rendering differs across OSes: compare captures made on the same machine.
- The `routes` area and the Clerk flavor need the fixture backend; the Clerk stub no-ops Clerk's
  prebuilt components (`mountSignIn` and friends), so those containers capture empty.
- `lab-worst-case` can flake under load: `span-hierarchy.tsx`'s scroll-to-selected loop stops on
  estimated row heights unless ResizeObserver measured the rows first, leaving `scrollTop` 96 px short.
  An app race; freezing only `Date` (real rAF instead of `page.clock`'s timer) did not fix it and
  made the service-map fit race (`service-map-canvas.tsx` marks the fit done before its rAF) flaky.
- `perf` from `docs/foldkit-migration.md` §3 is not ported yet.
