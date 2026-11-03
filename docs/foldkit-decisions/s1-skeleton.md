# S1: Skeleton spike

Status: **passed** · 2026-10-17 · Branch `fk/parity-harness`

Question: can a Foldkit app boot Maple's stack (both auth modes, the `@maple/domain` HTTP APIs,
every apps/web route) and render a real screen pixel-identical to apps/web?

## Result

`apps/web-foldkit` renders `/sign-in` in `self_hosted` mode, built and served exactly like apps/web
(same `VITE_*` env, static build, 1440x900, DPR 1, reduced motion), compared with pixelmatch:

| Scenario                          | Strict px | Perceptual px | DOM (attributes sorted) | Console errors      |
| --------------------------------- | --------- | ------------- | ----------------------- | ------------------- |
| sign-in, signed out               | **0**     | **0**         | identical               | none                |
| sign-in, wrong password (API 401) | **0**     | **0**         | identical               | the 401 itself only |

After a successful login against a fixture API, `/` renders a placeholder shell that shows the
result of `GET /internal/integrations/cloudflare/status`, the request the sidebar makes on every
boot. The fixture saw `POST /api/auth/login`, `GET /api/auth/session` (bearer) and the
Cloudflare status call (bearer), in that order.

Bundle: one JS chunk, 1,022.7 KB raw / 289.5 KB gzip; CSS 447.2 KB / 60.9 KB gzip. Most of the
JS is the four `HttpApiClient`s over every `@maple/domain` group and their schemas (S2 territory).

## What was proven

- **Styles:** `src/styles.css` imports apps/web's `styles.css` and `account-layout.css` in place
  and adds `@source "../../web/src"`, so both builds emit the same rules. The emitted CSS differs
  from legacy's in one rule only (a Clerk placeholder colour gets an extra fallback because it is
  bundled into the main sheet, not a route chunk). `publicDir` is `apps/web/public`.
- **Resources:** `src/platform/api-clients.ts` builds `HttpApiClient`s over `MapleApi`,
  `MapleInternalApi`, `MapleApiV2` and `MapleAiApi`, with apps/web's `transformMapleApiClient`
  (retry policy, `peer.service`) and `withRequestTimeout`, and a bearer from a `SessionBearer`
  service. Provided once through Foldkit `resources`.
- **Auth, self_hosted:** token in `sessionStorage` under `maple.self_hosted.token` (apps/web uses
  sessionStorage, not localStorage). Login, session check and renewal go through `MapleAuthApi`
  (plain fetch client, explicit bearer), mirroring `self-hosted-auth.ts`: a rejected check clears
  the token, an unreachable API keeps it, renewal is single-flight (a `Semaphore`) and a rejected
  renewal clears the token and fires `maple:self-hosted-auth-changed`, which a Subscription turns
  into a fresh session check. Flags read whether a token exists, so a signed-out visit paints the
  page directly instead of the boot splash.
- **Auth, clerk:** `src/platform/clerk.ts` loads clerk-js like `<ClerkProvider>` (same script URL,
  attributes and `load` options, after `purgeForeignClerkCookies`) unless `window.Clerk` already
  exists, so the harness stub works. State is read from `window.Clerk` and a Subscription over
  `Clerk.addListener`. The 2 s settle wait of `useClerkAuthSettled` is a `WaitForAuthSettle`
  Command. `/sign-in` mounts Clerk's SignIn through a Mount.
- **Routing:** one flat `AppRoute` union with all 88 non-lab routes of `routeTree.gen.ts`. Every
  route's `validateSearch` schema is mirrored in `src/route/search.ts` and carried as the route's
  `search`, decoded with TanStack's own format (`tanstack-search.ts`: JSON per value, raw string
  fallback, strings that would parse as JSON written quoted). Path params are percent-decoded
  like TanStack; ids that legacy decodes with `decodeSync` are branded segments (`AlertRuleId`,
  `AnomalyIncidentId`, `DashboardId`, `ErrorIssueId`, the workload `kind`). The six legacy
  `beforeLoad` redirects and the root auth gate (`/sign-in?redirect_url=`, `/org-required`, Clerk's
  reverse redirects) run after every route or session change and issue `ReplaceUrl` /
  `NavigateInternal` Commands.
- **Tests:** a Scene test for the sign-in update logic (typing, success with OutMessage,
  rejection, unreachable API) and route tests (search decoding, param encoding, literal-vs-param
  order, redirects).

## Porting method

1. **Reference DOM first.** Capture legacy's `#app` HTML in the target state (Playwright), then
   build the view until the attribute-sorted DOM is identical. Pixels follow.
2. **Port the composition, not the output.** Views call the same `cn` (imported from
   `packages/ui/src/lib/utils.ts`, framework-free) with the same arguments, so tailwind-merge
   drops the same conflicting classes (`text-base/4.5` vs `text-xs` on the field label).
   `cva`/class constants that live in React modules were copied verbatim (below) for Phase 1 to
   move into shared `*.styles.ts`.
3. **Mirror Base UI's state attributes.** Base UI writes `data-dirty`, `data-filled`,
   `data-focused`, `data-touched` and `data-invalid` on every field part; the sign-in Model keeps
   focus and touched state so the DOM matches in every state, not just the first paint.
4. **Same build inputs.** Same env handling, same Vite default `build.target`, same stylesheets
   and sources, same public dir. Then the CSS files can be diffed rule by rule.

Reused from apps/web by import (alias `@maple/web/*`): `auth-mode.ts`, `api-base-url.ts`,
`http-client.ts` (`withRequestTimeout`), `api-client-transform.ts` (+ `retry-policy.ts`),
`auth-headers.ts` (`readJwtExpMs` only), `clerk-cookie-guard.ts`. From `@maple/ui/*`:
`lib/utils.ts` (`cn`), `lib/sanitizers.ts` (`validateInternalRedirect`).

Copied, and why: `buttonVariants` cva and the Field/Input class lists (React modules), the Maple
mark path and loader icon (`.tsx`), `BootSplash` and `AccountLayout` markup (React components),
all `validateSearch` schemas (route `.tsx` files), `index.html` (entry script differs), the
self-hosted session logic (legacy is promise-based with module state and pulls in telemetry).

## Gotchas found

| Gotcha                                                                                                                                                                             | Fix                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `HttpApiClient`'s `baseUrl` is applied after the inner client's `mapRequestEffect`, so a bearer transform keyed on `apiBaseUrl` only sees relative URLs and silently sends no auth | Prepend the base URL inside the HTTP client layer, before the bearer mapping; do not pass `baseUrl` to `HttpApiClient` |
| A bearer-injecting client cannot also perform the renewal: it would wait on itself (apps/web uses `tracedFetch` there for the same reason)                                         | Separate `MapleAuthApi` on a plain fetch client with explicit bearer                                                   |
| apps/web's self-hosted token is in **sessionStorage**                                                                                                                              | Same storage, same key                                                                                                 |
| Foldkit's `string()` segment keeps percent-encoding; TanStack decodes `$param`                                                                                                     | `segment()` = `schemaSegment` over a percent-decoding codec                                                            |
| TanStack serialises search values as JSON per key (`?hasError=true` is a boolean, arrays are JSON)                                                                                 | One codec wraps every legacy schema (`tanstackSearch`)                                                                 |
| Legacy marks search arrays `Schema.mutable`; the route union is readonly, so the biparser types disagree                                                                           | Readonly arrays in the mirrored schemas                                                                                |
| Base UI field attributes (`data-dirty/filled/focused/touched`) and `useId` ids (`base-ui-_r_0_`) appear in the DOM                                                                 | Modelled field state; ids kept verbatim                                                                                |
| Legacy shows the browser's `TypeError` text for a network failure (`Failed to fetch` in Chromium)                                                                                  | `SignInFailure.Unreachable` renders that string; Safari/Firefox legacy text differs                                    |
| Middleware errors (`ApiUnexpectedError`) are not in an `HttpApiClient` endpoint's error channel                                                                                    | Only endpoint errors are matched by tag; the rest is `Unexpected`                                                      |
| Scene's `blur` needs a DOM `Element` and fails in the node environment                                                                                                             | Assert focus/touched via the DOM capture, not Scene                                                                    |
| `Schema.UnknownFromJsonString` is in effect's source but not its published types at 4.0.4                                                                                          | `Schema.fromJsonString(Schema.Json)`                                                                                   |

## Not done in S1

- PR-preview access form on Clerk-mode `/sign-in`; Clerk `appearance`/`localization` (needs
  `@clerk/themes`, not a dependency). Clerk-mode screens are not pixel-checked yet.
- Plan and region gates of `ClerkReverseRedirects` (Autumn customer, wrong-region screen).
- `sessionTimeRangeSearchMiddleware` (time range carried across navigations).
- Base UI toast portals that legacy appends to `<body>` (empty, invisible).
- Peer reachability bookkeeping (`noteReachable`) that `mapleFetch` does for warehouse errors.
- Route code splitting; the four API clients dominate the single chunk.
