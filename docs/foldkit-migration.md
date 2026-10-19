# Foldkit migration plan

Goal: replace the React frontends (`apps/web`, then `apps/local-ui`) with Foldkit apps that look
pixel-identical. Users notice nothing except speed and stability. Engineers get one Schema-typed
Model, Messages as facts and testable Commands. The method is the one Hazel used (Hazel
`docs/foldkit-migration.md`, harness at Hazel `286bbb07a:packages/ui-parity`).

Acceptance test: `packages/ui-parity`. A screen is ported when every scenario for its route reports
`identical` (or `pass` with 0 perceptual px), with 0 behavior diffs, no console errors and no
unmocked endpoints.

## Status (2026-10-19, branch `fk/parity-harness`, PR #1544)

Phases 0 to 4 and 7 done; cutover (6) switched, apps/web deletion open (section 6). Decision records: [S1 skeleton](foldkit-decisions/s1-skeleton.md),
[S2 bundle](foldkit-decisions/s2-bundle.md), [S3 charts](foldkit-decisions/s3-charts.md),
[S4 tables](foldkit-decisions/s4-tables.md), [S5 service map](foldkit-decisions/s5-service-map.md),
[S6 data](foldkit-decisions/s6-data.md), [S7 overlays](foldkit-decisions/s7-overlays.md),
[S8 pages](foldkit-decisions/s8-pages.md).

| Piece    | State                                                                               |
| -------- | ----------------------------------------------------------------------------------- |
| Pages    | Every `apps/web` route and lab page ported, plus command palette and shortcuts      |
| Local UI | `apps/local-ui-foldkit`: all routes, mobile sheets, map cache                       |
| Parity   | Last full run (5 of 7 foldkit chunks): 2,188 identical, 485 pass, 9 fail, 0 missing |
| Tests    | `apps/web-foldkit` 180 files, 964 Scene and unit tests                              |

Open fails from that run: `lab-worst-case` (known race, also on the old build),
`settings-clerk-billing-error` (fixed in `c6a1d0d08`, not yet rerun), and behavior-only diffs in
`dashboards-view-behind-reconnect`, `integrations-slack-add-workspace`,
`integrations-discord-install`, `agent-sessions-tools-search` (dark only). The services/traces/logs
chunk and the local chunk were not rerun after the last merges.

Deliberate deviations from legacy: a late save no longer closes another dialog, a reopened GCP
wizard does not create twice, chat refuses a send before history loads, some error states show a
toast instead of a banner.

Not ported: rows sliding aside during a list column drag, copy toasts in local-ui, the Clerk per-org
chat connector gate, the palette on standalone lab pages.

Legacy bug found by the harness: the infra service lens fires `workloadInfraTimeseries` once
with an empty workload name before the workload resolves (excluded via `pageCalls`).

## 1. Starting point (inventoried 2026-10-17)

|                       |                                                                                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`            | SPA on TanStack Router via `lib/effect-router`, 131 route files (92 user-facing, 39 lab), 1,714 files, 287k lines. Components 182k lines; biggest: infra 24.6k, dashboard-builder 19k, agent-sessions 14.9k, settings 11.2k, integrations 10.9k, alerts 9.8k, service-map 9k, replays 9k |
| `@maple/ui`           | ~80 Base UI primitives plus charts, plot, service map, traces, logs; 462 files, 55.7k lines. Also used by `apps/local-ui` (51 files), `apps/landing` (22), `apps/ai` (10)                                                                                                                |
| `apps/local-ui`       | Separate React + react-query SPA, 93 files, 11k lines, reuses `@maple/ui`                                                                                                                                                                                                                |
| State                 | `@effect/atom-react` through `src/lib/effect-atom.ts`: 208 files, ~520 hook calls. 4 `AtomHttpApi` clients over `@maple/domain` (358 endpoints, 46 groups). 5 Electric / TanStack DB collections                                                                                         |
| Warehouse             | One endpoint: `/internal/query-engine/execute-batch` (`src/api/warehouse/execute-batcher.ts`)                                                                                                                                                                                            |
| Auth                  | Clerk (41 files) or `self_hosted` root-password token (`VITE_MAPLE_AUTH_MODE`)                                                                                                                                                                                                           |
| Server                | Worker: API proxy, OG and chart images (`src/og`, takumi), meta rewriting. React-free, kept as is                                                                                                                                                                                        |
| Bundle                | Startup 703.1 KB gzip (budget 706.5 KB); all JS 6.6 MB gzip, mostly lazy (elk, mermaid, shiki grammars, three, rrweb)                                                                                                                                                                    |
| Tests                 | 205 node + 102 browser Vitest files in web (mostly RTL), 85 in ui, 10 Playwright perf specs on `/lab/bench/*`                                                                                                                                                                            |
| Reusable verification | 80 lab pages with fixtures, perf specs, `perf/check-bundle-budget.ts`, `scripts/seed-demo`, `self_hosted` auth                                                                                                                                                                           |

React-only dependencies and replacements:

| Legacy                                                  | Replacement                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `@tanstack/react-router` + `lib/effect-router`          | Foldkit flat route union, layouts as view helpers                              |
| `@effect/atom-react` atoms                              | Model fields, Commands from the existing Effect atom bodies, Subscriptions     |
| `@base-ui/react` (43 ui files)                          | Kit on `@foldkit/ui`, hand-built where its DOM cannot match                    |
| `@tanstack/react-table` / `react-virtual`               | `@tanstack/table-core` / `@tanstack/virtual-core` or `@foldkit/ui` VirtualList |
| `@tanstack/charts/react` adapter (1 file)               | `@tanstack/charts` core in a Mount                                             |
| `@xyflow/react` (26 files)                              | `@xyflow/system` in a Mount, or SVG + d3-zoom (spike S5)                       |
| `@react-three/fiber`                                    | vanilla three in a Mount, lazy                                                 |
| `streamdown`                                            | `@foldkit/markdown` view + mermaid/katex/shiki in lazy Mounts                  |
| `motion`, `react-day-picker`, `@tanstack/react-hotkeys` | vanilla motion in Mounts, Foldkit Calendar/DatePicker, key bindings            |
| `@tanstack/react-db` `useLiveQuery`                     | `liveQuery` Subscription over the same collections (Hazel S2)                  |
| Clerk React components                                  | `Clerk.mount*` in Mounts, auth state via `window.Clerk` listener               |

## 2. Strategy

- New app `apps/web-foldkit` beside `apps/web`, cut over in one switch (Hazel §2.1).
- Legacy baseline pinned by `LEGACY_BASELINE_REF` in `packages/ui-parity/src/config.ts`. Re-pin only
  in a dedicated commit that shows legacy-vs-legacy identical.
- Framework-free code is reused, not rewritten: `@maple/domain`, `@maple/query-engine`,
  `@maple/widgets`, `lib/grid-engine`, `@maple/agent-sessions`, `apps/web/src/api/warehouse/*`,
  formatting and colour helpers, collections. `tv()` and class composition move to
  `*.styles.ts` files consumed by both kits; every extraction is proven neutral with
  `parity run --baseline legacy --candidate legacy-head`.
- `@maple/ui`'s React kit stays until `apps/local-ui` is migrated (Phase 8); `apps/landing` keeps
  only what it imports.

## 3. Verification flow (`packages/ui-parity`)

| Piece                                | Maple specifics                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build legacy\|legacy-head\|foldkit` | Static Vite builds with every `VITE_*` URL pointed at the fixture origin; legacy built from the pin in `~/.cache/maple-ui-parity/worktrees`                         |
| Fixture backend                      | `HttpApiBuilder` over the real `@maple/domain` groups, handlers per dataset, unmocked endpoint fails the variant                                                    |
| Warehouse                            | `execute-batch` compiled by the real query-engine and run on chDB (apps/cli's binding) seeded deterministically at the dataset's frozen `now`                       |
| Electric                             | Minimal `/v1/shape` server for the 5 collections                                                                                                                    |
| Auth                                 | `self_hosted` token in localStorage by default; `window.Clerk` stub for Clerk-only screens                                                                          |
| Behavioral parity                    | Call log per capture (endpoint + payload, including every warehouse query), diffed as multisets                                                                     |
| Determinism                          | Frozen clock, UTC, DPR 1, seeded `Math.random`, frozen animations, canvas settle, fonts and images decoded, two identical screenshots in a row; console errors fail |
| Compare                              | Strict + perceptual px, structural style deltas grouped by root cause, ARIA snapshots, HTML report                                                                  |
| `selfcheck`, `coverage`              | Determinism; burndown from `routeTree.gen.ts`                                                                                                                       |
| `perf`                               | Existing `perf/*.spec.ts` against both builds, frame-cost traces, heap, bundle                                                                                      |
| `PARITY_PORT_BASE`                   | Parallel worktrees                                                                                                                                                  |

## 4. Phases

0. Harness, S1 skeleton (one screen identical), spikes: S2 bundle without route splitting, S3 charts
   on canvas, S4 logs/traces tables at bench parity, S5 service map, S6 data layer. Decision records
   in `docs/foldkit-decisions/`. If S2, S4 or S5 fails badly, stop and reconsider.
1. Foundations: styles extraction, kit with lab/gallery scenarios, icons generated from source.
2. Shell: sidebar, org/namespace switchers, time range picker, command palette, modals, toasts.
3. Areas in parallel: overview, services, traces, logs, metrics, errors, alerts, dashboards, infra,
   service map, replays, agent sessions, investigations, code review, analytics, settings,
   integrations, onboarding/auth, share.
4. Chat and AI surfaces.
5. Platform and polish: telemetry SDK, replay capture, accessibility, perf budgets.
6. Cutover: switch the deploy, service-worker tombstone if needed, delete `apps/web`.
7. `apps/local-ui` onto the Foldkit kit, then delete `@maple/ui`'s React kit.

## 5. Definition of done (per screen)

Identical scenarios at desktop and mobile (if responsive) in light and dark; default, empty,
loading, error and overflow states; 0 behavior diffs; Scene tests for update logic; ARIA roles
and names match.

## 6. Cutover

The `app` Worker (`apps/web-foldkit/src/worker.ts`, logical id `app`, Worker name `maple-web-*`)
builds apps/web-foldkit on every stage and region. The domain, Worker name, env and alchemy state
are unchanged, so there is no DNS, certificate or Clerk origin change. `app-pr-<n>` serves Foldkit;
the separate `fk-pr-<n>` Worker is gone (alchemy deletes it on the next deploy of an open PR, the
orphan sweep reaps closed ones by its `maple-web-foldkit-pr-<n>` name).

`MAPLE_WEB_APP` picks the build: `foldkit` (default) or `react` (apps/web). Both run apps/web's
Worker entry, so the `/_api` proxy, OG and chart images, share meta rewriting and the frame and
referrer headers are the same. Both builds ship `apps/web/public` and `/version.json`, so a tab on
the old bundle sees the newer commit and offers a reload. apps/web had no service worker, so no
tombstone is needed.

Rollback:

1. Set `MAPLE_WEB_APP=react` in the deploy environment (Infisical `prod` and `prod-<region>` for
   prd, `dev` for previews).
2. Re-run the deploy (`deploy-prd.yml`, or push to the PR for a preview). The `app` Worker rebuilds
   from apps/web; nothing else changes.
3. To return to Foldkit, remove the variable (or set `foldkit`) and redeploy.

Still to do: delete apps/web (move `src/worker-entry.ts`, `handler.ts`, `og/`, `api-proxy*`,
`worker-env.ts`, `public/` and the version plugin into apps/web-foldkit first), its bundle budget
and its perf specs. The preview e2e suite (apps/web/e2e) selects by role and label, so it runs
against Foldkit unchanged; it moves with the rest.
