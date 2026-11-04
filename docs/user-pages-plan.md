# User pages plan

Goal: a customer opens one page for one of **their** end users and sees everything Maple knows about
that person: who they are, their sessions and replays, the errors they hit, their traces and logs,
and the product events they fired. Plus a `/users` directory to find them.

## What exists today

| Signal | Where the user is | Query cost per user |
| --- | --- | --- |
| Replays | `session_replays.UserId/UserEmail/UserName/UserTraits`, `VisitorId` | Cheap. `listSessionReplays` already filters on `userId` and `userSearch` |
| Session events | `session_events.UserId/VisitorId` | Sorted by `SessionId`, so go through sessions |
| Product events | `product_events.UserId/VisitorId`, `idx_user_id` bloom | OK. Person key `if(UserId != '', UserId, VisitorId)` |
| Identity | `identity_links (VisitorId, UserId, FirstSeen)` | Cheap |
| Traces | `SpanAttributes['user.id']` (browser + effect-sdk stamp it), else `enduser.id` | Expensive: only the map-value bloom index, sort key starts at `ServiceName` |
| Logs | `LogAttributes['user.id']` (browser logs stamp it) | Expensive, same reason |
| Errors | `error_events` has **no** user column | Not possible without a join back to traces |

The SDKs already do the hard part: `identify()` / `user` puts the same id on replays, events, spans
and logs. `mcp.ts` already has the `user.id` else `enduser.id` resolution to reuse.

## Pages

- **`/users`** list: id, name/email, last seen, sessions, errors, top service/route, first seen.
  Search by id, name, email. Filters: has errors, has replays, group, time range.
- **`/users/:userId`** detail, header (identity, traits, group, first/last seen, linked visitor ids)
  then tabs:
  - **Activity**: one merged timeline (sessions, errors, slow/failed requests, key product events),
    the default tab and the main reason the page exists.
  - **Sessions**: replay rows (reuse `replays/kit/session-row.ts`).
  - **Errors**: issues this user hit, with counts and last occurrence.
  - **Traces** and **Logs**: the existing list views pre-filtered to the user.
  - **Events**: product events stream.
- Cross-links in: replay detail, trace detail (`user.id` attribute chip), error issue
  ("affected users" list), command palette (search by id/email).
- Empty state is the integration on-ramp (`identify()` snippet + server `user.id` attribute), never
  demo data.

Built as a Foldkit page `apps/web/src/page/users/{list,detail,kit}` mirroring `page/replays`, kit
components only (`apps/web/CLAUDE.md`, `packages/views/src/ui/INDEX.md`).

## Data design

1. **Directory without schema changes (phase 1).** Users come from `session_replays` (argMax
   identity fields per `UserId`) union `product_events` (server-only users), stitched with
   `identity_links`. New `CH.listUsers` / `CH.userProfile` in `ch/queries/users.ts`.
2. **`user_activity_hourly` rollup (phase 3).** AggregatingMergeTree on
   `(OrgId, UserId, Hour, ServiceName)` fed by MVs from `traces` and `logs` where the resolved user
   id is non-empty: span count, error spans, `uniq(TraceId)`, `uniq(session.id)`, top routes,
   min/max timestamp. It powers list counts and, more importantly, **pruning**: the Traces/Logs tabs
   first read which `(hour, service)` buckets the user was active in, then query raw `traces` only
   for those services and hours, so the sort key prefix does the work instead of a full-range bloom
   scan. Read `docs/warehouse-rollups.md` first; stage the backfill (Tinybird CPU bursts).
3. **`UserId` on `error_events` (phase 4).** Materialize it in the error MV from the same
   resolution, enabling "affected users" on issues and the Errors tab. Read
   `docs/error-issue-lifecycle.md`; fingerprints are untouched, so no `FINGERPRINT_VERSION` bump.

### Namespaces

Every users query takes the page's namespace scope: the org-global pin when it is set (it wins,
as on traces), else the rail's Namespace picks. A user belongs to every `service.namespace` their
signals reached, so the list keeps a user when any of theirs is in scope, and the detail page drops
rows from services outside it.

- Traces and logs carry `ResourceAttributes['service.namespace']`, so `user_activity_hourly` keys
  on `(OrgId, ServiceNamespace, UserId, Hour, ServiceName)` and the namespace filter prunes by the
  sort key.
- `session_replays` and `product_events` have no namespace column, only the service. Resolve it
  through the services facets map (`ServiceName` -> `ServiceNamespace`, the one the shell's
  namespace list already reads) and filter on `ServiceName IN (...)`.
- `error_events.UserId` (phase 4) joins the same way: issues carry `ServiceName`.
- The detail page shows a scope bar ("Namespace storefront, Pinned, 2 more hidden") and a rail
  group with the user's share per namespace, so a pinned scope never silently hides activity.

Every query filters `OrgId`, `UserId` arrives as a validated param at the HTTP boundary, and the
queries compile for local chDB too (`bun run local-schema:bump` for phases 3 and 4).

## API and agent surface

- v2 endpoints: `GET /v2/users`, `GET /v2/users/{userId}`, `GET /v2/users/{userId}/activity`
  (`docs/api-v2.md`).
- MCP tools `list_users` / `inspect_user` (params from `P.*`, outputs in
  `packages/domain/src/mcp-outputs/`), so investigations can answer "what happened to user X".

## Phases

| # | Ships | Schema change | Verify |
| --- | --- | --- | --- |
| 1 | `/users` list from replays + product events + identity links | none | query tests, `bench:queries` on real data, `preview:web` screenshots |
| 2 | Detail page: header, Sessions, Events, Activity (sessions + events only), cross-link from replays | none | same |
| 3 | `user_activity_hourly`, Traces/Logs tabs, backend-only users in the list, trace detail link | MV + backfill | full `preview` (Tinybird branch), bench pruning vs raw scan |
| 4 | `error_events.UserId`, Errors tab, affected users on issues | MV column | full `preview`, issue lifecycle tests |
| 5 | v2 API, MCP tools, command palette search | none | registry contract test, tool playground |

Each phase is one PR (or one gh stack layer) with before/after screenshots for UI changes.

## Privacy

Users are our customers' PII. Show only to org members, keep it out of dashboard share links,
respect `privacy.captureUserEmail` and ingest rules that drop `user.email`. Per-user data deletion
(GDPR erase) is a follow-up, but the `UserId` columns from phases 3 and 4 make it possible.

## Open questions

1. Name: **Users** or **People** (product analytics already says "person")?
2. Anonymous visitors: list them too (VisitorId only), or identified users only?
3. B2B: also an **Accounts** page per `GroupId` (all users of one customer company)?
4. Retention: product events and replays have different TTLs than traces; the page shows what still
   exists, but should the list say so?
