# HTTP API tiers and the v1 retirement

Status: v1 retired 2026-10-08. There is no `/api` HttpApi group left that is versioned public surface.

The governing rule is consumer intent, not transport convenience:

- `/v2` is the stable public resource API for customers, agents, IaC, and the dashboard.
- `/internal` is the private dashboard transport for product workflows that can change with the UI. It is a separate `HttpApi` (`MapleInternalApi`), session-only via `SessionAuthorization`, and absent from the API reference. It is deliberately NOT a distinct wire protocol: the boundary is who may call it, not how.
- `/api` keeps only version-neutral surface whose URLs live in clients we cannot redeploy: the `MapleApi` HttpApi (CLI device login and session, MCP OAuth consent, password login, the unauthenticated plan catalog, email unsubscribe) and raw `HttpRouter` routes (OAuth callbacks, webhook receivers, worker-to-worker routes, chat streaming). Nothing new goes here.

## Where each v1 group went

| v1 group | Destination |
| --- | --- |
| `apiKeys`, `ingestKeys`, `ingestAttributeMappings`, `recommendationIssues`, `scrapeTargets`, `investigations`, `anomalies`, `dashboards`, PlanetScale | `/v2`; v1 deleted 2026-08-14 |
| `observability`, `onboarding`, `warehouse` | Deleted outright (no callers) |
| `queryEngine`, `billing`, `demo`, `digest`, `aiTriage`, `chat` (apply) | `/internal`, August 2026 |
| `sessionReplays` | `/v2/session_replays`; v1 deleted 2026-10-08 after 30 quiet days. Facets and trace summaries are `/internal/session-replays`. |
| `errors` | `/internal/errors`, 2026-10-08. Ten operations without a caller were deleted. Reads are `/v2/error_issues`. |
| `integrations` (Hazel, Cloudflare, Railway, GitHub, VCS lookups), `codeReview` | `/internal/integrations`, `/internal/code-review`, 2026-10-08. `githubListPrReviews` was deleted (no caller). |
| `orgClickHouseSettings`, `organizations`, `organizationCreation`, `organizationRegion` | `/internal/org-clickhouse-settings`, `/internal/organizations`, 2026-10-08 |
| `auth`, `authPublic`, `billingPublic`, `emailPublic` | Stay on `MapleApi` at their `/api` URLs (version-neutral, see above) |

Moving a group to `/internal` swaps `Authorization` for `SessionAuthorization`, which refuses API-key-shaped bearers. Production traffic for the 2026-10-08 moves was dashboard traffic, and the break for any API-key caller was accepted. One documented manual flow is affected: `GET /internal/org-clickhouse-settings/collector-config` now needs a dashboard session (see `self-hosted-clickhouse.md`).

## Open follow-ups

- **Error-issue writes on v2.** Transitions, comments, severity, assignee, events, pull-request links, verifications, and escalation history are candidates for `/v2/error_issues/{id}/...`. Agents already reach them through MCP tools, so this needs a deliberate public contract, not a lift of the internal shapes. Lease coordination (claim, heartbeat, release) and escalation-policy evaluation stay internal.
- **Organization and BYO ClickHouse on v2.** Organization delete and ClickHouse configuration as `/v2/organization` subresources, if IaC demand appears.

## The one unauthenticated v2 group

`sharePublic` (`packages/domain/src/http/v2/share.ts`: `POST /v2/share/resolve`, `/widget-data`, `/og-meta`, `/og-card`, `/alert-chart`, `/chat-chart`) is the only group on `MapleApiV2` **without** `AuthorizationV2`. It is the viewer half of dashboard share links: the token in the request body is the credential, and the whole proposition is that the link resolves for someone with no Maple account, so requiring a bearer would mean it only worked for people who did not need it. Share _management_ (`/v2/dashboards/{id}/share`, and the widget-scoped twins) is ordinary authenticated v2 surface and carries the `dashboards` scope family.

Three consequences, all deliberate:

- **No scope.** `requiredScopeForRoute` would derive the family `share` from the path, but it is only called by `ApiAuthorizationV2Layer`, which these routes never run. There is no `share:read` scope and nothing issues one.
- **`security: []` and no `401`** in the OpenAPI spec. `openapi.test.ts` exempts these operations by operationId through `PUBLIC_OPERATION_IDS`. It is an allowlist, so a new public operation cannot appear without someone editing it. Every other operation guarantee still applies to them.
- **The v2 rate limiter never runs.** These routes carry their own per-token and per-IP limiter in the handler; it is the only one on the path, not a supplement.

Prefer this shape over a new unauthenticated group. If a future surface needs anonymous access, weigh `/api/…` (as `billingPublic` did) first. The exemption above is narrow on purpose.

The frontend halves of that move are easy to get wrong in ways nothing type-checks:

- `apps/web/src/lib/services/common/api-client-transform.ts` scopes the billing 401-retry by URL. It now matches **both** `/internal/billing/` and `/api/billing/`, because the authenticated operations and the public plan catalog ended up on different prefixes. Dropping either reinstates the hard 401 that the retry exists to prevent.
- `MapleInternalAtomClient` gained `retainedInternalQuery`, the `/internal` twin of `retainedQuery`, so the migrated settings panels keep unmount-surviving retention instead of flashing a skeleton on every visit. Its cache identity is prefixed `internal:` so a group name present on both clients cannot share a retention slot. Warehouse reads still go through `runWarehouseQuery` and must **not** be wrapped in it as well.

The following raw routes are intentional end-state routes:

- OAuth callbacks that return redirects or RFC-defined OAuth errors.
- Webhook receivers whose signatures, retry status, and body are defined by the provider.
- Internal scraper or worker routes protected by service credentials.
- Streaming endpoints that cannot use the regular JSON request/response contract.

They still use typed internal failures and sanitized logging, but they keep their protocol-specific wire response instead of a JSON API envelope.

## v2 telemetry gaps in CLI remote mode

Rebuilding the CLI's remote mode on v2 surfaced capabilities local mode has and the public API does not. The CLI now covers each of them through the workspace's MCP tools rather than a v2 resource (`docs/local-mode.md` maps command to tool), so none blocks a command any more. They remain v2 gaps:

- **No attribute discovery.** Nothing in `/v2` returns the attribute keys or values observed in telemetry; `/v2/attribute_mappings` is mapping configuration. This blocks `maple attributes` entirely and is the largest gap.
- **`/v2/traces/search` cannot sort.** It filters by `min_duration_ms` but has no order parameter, so "slowest N traces" is unexpressible.
- **No span-level search.** Search returns root-based `V2TraceSummary`; there is no way to list spans matching a name, and its `span_name` filter matches exactly where the CLI matches a substring.
- **Breakdown returns one aggregation per request.** A combined ranking (count + latency + error rate) needs N calls and cannot be ordered server-side by a composite.
- ~~**No fingerprint → issue lookup.**~~ Closed: `/v2/error_issues` takes a `fingerprint_hash` filter, and the CLI's `maple error <fp>` runs on it remotely.
- **No exception-type aggregate.** `/v2/error_issues` holds one triage object per fingerprint. It covers only fingerprints a sweep has turned into issues, and cannot say how many services an error spans, which `maple errors` prints.
- **No window comparison.** Nothing corresponds to `service_overview_compare`.
- **Offset pagination.** v2 lists seek by opaque cursor and cap at 100 rows, so `--offset` cannot be honoured.

There must never be a generic `/v2/query`, `/v2/sql`, or public query-builder execution endpoint. Those contracts expose Maple's storage and dashboard implementation rather than a durable product resource.
