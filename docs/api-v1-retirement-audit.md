# Remaining v1 APIs and migration plan

Audit snapshot: 2026-09-07. The inventory below describes the pre-migration baseline.

Implementation update: the replay slice is now implemented locally. All four remaining web calls use v2, attribution/detail/custom-event fields are preserved, and list pagination uses opaque cursors. The four v1 replay endpoints remain mounted with OpenAPI deprecation metadata; deployment, sunset headers, and the external-usage retirement window are still pending. See `http-api-migration.md`.

## Current inventory

`MapleApi` still mounts **71 operations in eight groups**, all under `/api/...`. Repository call sites exist for **60 operations**: 49 through the typed web client and 11 additional auth operations through direct HTTP requests. **11 operations have no first-party HTTP caller identified.** These are source-usage counts, not traffic measurements.

The executable inventory comes from [MapleApi](../packages/domain/src/http/api.ts), checked against the [HTTP route graph](../apps/api/src/runtime/http-graph.ts). All 71 also appear in generated v1 OpenAPI; **zero are marked deprecated**.

| Group                   | Mounted operations | Operations with first-party HTTP callers | Current consumers                                                                | Destination                                                                                                                 |
| ----------------------- | -----------------: | ---------------------------------------: | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `authPublic`            |                  3 |                                        3 | Self-hosted sign-in; CLI device start/poll                                       | Dedicated protocol contract, preserving URLs                                                                                |
| `auth`                  |                  9 |                                        9 | Web identity/admin checks; self-hosted refresh; CLI login/logout; MCP consent UI | Dedicated protocol contract, preserving URLs                                                                                |
| `billingPublic`         |                  1 |                                        1 | Billing plan catalog                                                             | Dedicated public catalog contract; preserve anonymous access                                                                |
| `errors`                |                 26 |                                       16 | Issue detail/actions, bulk actions, escalation settings, investigation metadata  | Public issue resources to v2; dashboard coordination to `/internal`                                                         |
| `integrations`          |                 20 |                                       20 | Hazel (5), Cloudflare (7), GitHub (5), VCS lookups (3)                           | Hazel to v2; existing Cloudflare/GitHub/VCS dashboard controls to `/internal`, subject to the public-dependency check below |
| `orgClickHouseSettings` |                  7 |                                        6 | BYO ClickHouse settings, schema diff/apply/status                                | Organization ClickHouse subresource in v2                                                                                   |
| `organizations`         |                  1 |                                        1 | Organization deletion                                                            | `DELETE /v2/organization`                                                                                                   |
| `sessionReplays`        |                  4 |                                        4 | Replay search/detail, transcript, trace correlation                              | Existing `/v2/session_replays` operations after parity work                                                                 |
| **Total**               |             **71** |                                   **60** |                                                                                  |                                                                                                                             |

Already migrated: dashboard CRUD, alerts, API/ingest keys, attribute mappings, scrape targets, investigations, anomalies, audit, Slack and PlanetScale controls. CLI remote telemetry uses [MapleApiV2](../apps/cli/src/core/v2-client.ts). The Alchemy provider's resource operations use `/v2` too; its service named `MapleApi` is not the legacy contract. Query-engine reads, authenticated billing, demo, digest, AI triage, replay facets/trace summaries, and AI-session dashboard operations already use `MapleInternalApi`.

MCP issue tools call backend services directly. For example, [claim-error-issue.ts](../apps/api/src/mcp/tools/claim-error-issue.ts) calls `ErrorsService`, with identity resolved by [resolve-actor.ts](../apps/api/src/mcp/lib/resolve-actor.ts). Retiring an HTTP route does not authorize deleting the service or narrowing MCP authentication.

## Findings that change the migration

1. **Replays need response parity and a pagination migration.** V2 search/retrieve omit visitor ID, acquisition/referrer/UTM dimensions, entry/exit paths, and the list's recording marker. The current UI renders these fields. V2 already accepts visitor, user/group, duration, and active-time filters, so these filters do not need reinvention. The list still uses offsets and page-length inference in [use-infinite-replays.ts](../apps/web/src/hooks/use-infinite-replays.ts); switching the HTTP client alone would not implement v2 cursor pagination. Playback manifest and bounded event chunks are already v2 and must remain bounded. Compare [v1 replay schemas](../packages/domain/src/http/session-replay.ts), [v2 replay schemas](../packages/domain/src/http/v2/session-replays.ts), and [the web adapter](../apps/web/src/api/warehouse/replays.ts).

2. **Error-issue v2 is read-only.** It has only `list`, `serviceCounts`, and `retrieve`. The detail page already uses v2 for the main resource but still uses v1 for events, mutations, PRs, verification, and escalation history. Also, v1 `listIssues` accepts `assignedActorId` and `includeArchived`, which are absent from v2. Even a route with no repository caller is not automatically a feature-equivalent duplicate. See [v2 error issues](../packages/domain/src/http/v2/error-issues.ts), [v1 handlers](../apps/api/src/routes/v1/errors.http.ts), and [the issue page](../apps/web/src/routes/errors/issues/$issueId.tsx).

3. **Hazel now qualifies for public v2.** [V2 alert destinations](../packages/domain/src/http/v2/alert-destinations.ts) accept `hazel-oauth`, require Hazel organization/channel IDs, and provision a webhook through the server's stored OAuth connection. Connection setup and discovery are still v1; the [destination dialog](../apps/web/src/components/alerts/destination-dialog.tsx) calls all five Hazel operations. Moving these to session-only `/internal` would leave public alert-destination clients without a supported v2 setup/discovery flow. Promote the provider as Slack was promoted.

4. **The architecture documents disagree with implementation.** [api-v2.md](api-v2.md) says the private tier is an unbuilt Effect RPC transport at `/rpc` and that PlanetScale v1 remains mounted. The actual private tier is an implemented `HttpApi` at `/internal`, and PlanetScale v1 operations are gone. [http-api-migration.md](http-api-migration.md) gets that split right but still assigns Hazel to the private tier. Use executable contracts as the source of truth and reconcile both documents in the first migration change.

## Proposed implementation slices

### 1. Establish the retirement ledger and correct the docs

- Keep the inventory below as the baseline, including separate classifications for resource APIs, private dashboard operations, and protocols.
- Reconcile the tier descriptions and provider status in both existing documents. Do not introduce a new RPC transport as part of this work.
- For each replacement, record field/filter parity, callers, deprecation date, traffic evidence by deployed stage, and final deletion status. Mark the old operation deprecated only when its replacement or explicit retirement decision is concrete.
- Add the existing retirement policy's deprecation, sunset, and migration-link response headers, with an announced window. No remaining operation currently has OpenAPI deprecation metadata, and no corresponding header implementation was found in the API source search.

### 2. Finish replays and move all four callers

- Extend the v2 response schemas and handler mappers with `visitor_id`, `visitor_is_new`, `referrer`, `referrer_host`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `entry_path`, `exit_path`, and the recording state where applicable to list/detail. Preserve old-session unknown values; an absent recording marker must not become `false`.
- Migrate `listReplays → search`, `getReplay → retrieve`, `replaysForTrace → forTrace`, and `sessionTranscript → transcript` in the web adapter.
- Carry `has_more` and `next_cursor` through the list adapter and infinite-scroll hook; stop deriving continuation from row count or offsets. For transcript/trace-correlation lists, honor each v2 collection's pagination and preserve current UI completeness.
- Preserve decoded IDs through the typed client, ISO timestamp conversion, optional query windows, cache keys/retention, filter resets, and not-found/error behavior. Do not manually double-encode `srep_` IDs.
- Validate populated attribution fields, anonymous and identified sessions, unknown/unrecorded states, visitor linking, multiple list pages, filter changes during pagination, transcript completeness, reverse trace links, and the existing bounded playback path.

### 3. Complete the smaller public resources

- **Hazel:** add a separate v2 provider group with status, connect, disconnect, organization discovery, and channel discovery under `/v2/integrations/hazel`. Use `integrations:read/write`, preserve administrator checks on sensitive discovery/mutations, and keep the OAuth callback URL. Migrate the destination form and integration cards together. Validate the complete connect → select organization/channel → create/test destination path, including expiry/disconnection errors.
- **Organization deletion:** add `DELETE /v2/organization`, retaining the existing service's authorization, cleanup, audit, and final-response behavior. Use an explicit write scope plus the existing administrator check. Migrate the one web mutation and preserve post-delete organization switching. Renaming/logo updates currently call Clerk directly; moving those is separate product scope, not v1 retirement.
- **ClickHouse settings:** design `GET/PUT/DELETE /v2/organization/clickhouse` and explicit children for schema diff, apply, apply status, and collector configuration (for example `/schema_diff`, `/apply_schema`, `/apply_schema/status`, `/collector_config`). Keep configuration admin-only and credentials write-only. Preserve password-retention semantics, idempotency/concurrency behavior of schema application, current status polling, tenant selection, and domain errors. Migrate the six settings-panel operations. The unused collector-config HTTP operation must either receive a supported automation replacement or pass the removal gate; do not drop its underlying service merely because the UI does not call it.

These are separate reviewable changes; Hazel and organization deletion do not depend on replay completion.

### 4. Split errors by consumer intent

- Add stable v2 issue subresources for events, comments, transitions, severity, linked PRs, and verification results—the operations the dashboard currently uses. Add assignment/fix proposals/incident listing and notification-policy resources if these remain supported HTTP capabilities; otherwise explicitly retire their unused HTTP routes after the gate. Add assignee/archive list filters before claiming full list parity.
- Move dashboard claim/heartbeat/release and escalation-policy evaluation/history to dedicated `/internal` groups. Decide agent registration/listing and policy-management destinations from supported callers rather than copying all 26 operations wholesale. Existing MCP automation keeps using the shared services and its existing credential/actor resolution.
- Preserve the lifecycle in [error-issue-lifecycle.md](error-issue-lifecycle.md): machine-owned states, lease ownership, human versus agent severity precedence, PR linking, and post-merge verification. New v2 mutation handlers must resolve the correct actor for both sessions and scoped API keys; blindly copying v1's `ensureUserActor` calls would misattribute agent actions.
- Keep semantic tagged failures through the v2 envelope. Verify tenant isolation, role/scope refusals, conflicting leases, invalid transitions, duplicate mutation/retry behavior, activity pagination (the UI currently requests 200 events, above v2's 100-row cap), cache invalidation, and the issue's detail/bulk-action UI.

### 5. Move the remaining provider dashboard controls

- Split Cloudflare's seven operations and GitHub/VCS's eight into independently owned contracts and handlers, then migrate their web callers to `MapleInternalAtomClient` and `retainedInternalQuery` where appropriate.
- Preserve current organization-admin checks, OAuth popup behavior, post-connect invalidation, service-map enrichment, and error presentation. Keep raw callback/webhook receiver URLs stable.
- Recheck GitHub's destination while designing public issue PR management in slice 4: if that public workflow requires Maple-held connection setup or provider discovery, promote that provider control surface to v2 in the same change. A new public workflow must not require an undocumented v1 operation or a dashboard-only transport to complete its supported setup.
- A move to `/internal` rejects API-key bearers. Treat that as an authentication change and establish external usage evidence before retiring the old routes; MCP's direct service calls are not evidence of v1 HTTP traffic.

### 6. Separate protocols and remove the legacy client

- Move the 12 auth operations into a dedicated protocol `HttpApi`/client while preserving `/api/auth/...`, wire shapes, and accepted credentials. Session inspection is used by both the dashboard and CLI; do not make it session-only accidentally.
- Move the anonymous pricing catalog into its own small public contract while preserving `/api/billing/plans`. A v2 pricing API would require a separate public-resource decision, not a mechanical prefix change.
- Once callers have moved, remove `MapleApiAtomClient` and its legacy query wrapper. Migrate shared runtime users in `registry.ts`, `models/runtime.ts`, warehouse atoms, and widget-data hooks to an appropriate common runtime before deleting it; several use `.runtime` without issuing any v1 request.
- Delete empty groups, handlers, graph registrations, obsolete tests, and exclusive errors together. Keep shared domain schemas still imported by v2, services, or MCP. `V1SchemaErrors`/`V1UnexpectedErrors` also serve `/internal`; naming alone does not make them deletable.
- Raw OAuth, signed webhooks, service-authenticated worker routes, and streams can be relocated out of `routes/v1/` for ownership clarity while preserving protocol URLs. OTLP `/v1/traces`, `/v1/logs`, `/v1/metrics`, replay/event ingest, Electric `/v1/shape`, and third-party `/v1` URLs are outside this application API migration.

## Operations with no identified first-party HTTP caller

The ten error operations are `listIssues`, `getIssue`, `proposeFix`, `assignIssue`, `listIssueIncidents`, `listOpenIncidents`, `registerAgent`, `listAgents`, `getNotificationPolicy`, and `upsertNotificationPolicy`. The eleventh is `orgClickHouseSettings.collectorConfig`.

They are **retirement candidates, not proven dead endpoints**. Some capabilities have live MCP/service consumers; list/retrieve have v2 equivalents with differences in filtering. First migrate a supported external capability or explicitly retire it, then apply the gate.

## Deletion gate and verification

Use the five conditions in [http-api-migration.md](http-api-migration.md): no remaining first-party callers; deprecation and migration notice; zero legitimate calls for 30 consecutive days in every deployed stage; no published SDK/IaC/docs/examples generating old calls; and complete removal of operation-only wiring in the same change. Keep a thin adapter over shared services until those conditions pass. An old historical exception is not evidence that the next deletion is safe.

For this review, the connected telemetry service inventory did not establish access to Maple's own API telemetry. No per-operation, per-stage zero-traffic window was verified. Do not start the retirement clock from this audit's date or infer zero usage from source searches or sampled traces.

Checks performed:

- Enumerated the mounted v1 contract and generated OpenAPI: 71 operations; zero deprecated.
- Matched typed web calls and direct auth calls against the inventory; inspected CLI, Alchemy provider, MCP service boundaries, route registration, and v2 counterparts.
- Ran `bun run --cwd packages/domain test src/http/v2/openapi.test.ts`: **39 tests passed**. This validates existing OpenAPI invariants, not the proposed migrations or external usage.
- Reviewed against installed Effect `4.0.0-rc.111`. No application source was edited and no deployments were made.

## Endpoint ledger

The following inventory lists every mounted v1 operation. A representative repository HTTP caller is linked when present; `No HTTP caller found` carries the limitations above. Paths are current, not proposed.

### `authPublic`

| Operation        | Method and path                   | Representative HTTP caller                               |
| ---------------- | --------------------------------- | -------------------------------------------------------- |
| `login`          | `POST /api/auth/login`            | [sign-in.tsx:43](../apps/web/src/routes/sign-in.tsx#L43) |
| `cliDeviceStart` | `POST /api/auth/cli/device`       | [auth.ts:193](../apps/cli/src/commands/auth.ts#L193)     |
| `cliDevicePoll`  | `POST /api/auth/cli/device/token` | [auth.ts:216](../apps/cli/src/commands/auth.ts#L216)     |

### `auth`

| Operation                      | Method and path                                             | Representative HTTP caller                                                            |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `session`                      | `GET /api/auth/session`                                     | [index.tsx:46](../apps/web/src/routes/alerts/index.tsx#L46)                           |
| `sessionRefresh`               | `POST /api/auth/session/refresh`                            | [self-hosted-auth.ts:82](../apps/web/src/lib/services/common/self-hosted-auth.ts#L82) |
| `cliDeviceInspect`             | `GET /api/auth/cli/device/:userCode`                        | [cli-login.tsx:57](../apps/web/src/routes/cli-login.tsx#L57)                          |
| `cliDeviceApprove`             | `POST /api/auth/cli/device/:userCode/approve`               | [cli-login.tsx:64](../apps/web/src/routes/cli-login.tsx#L64)                          |
| `cliDeviceDeny`                | `POST /api/auth/cli/device/:userCode/deny`                  | [cli-login.tsx:64](../apps/web/src/routes/cli-login.tsx#L64)                          |
| `cliSessionRevoke`             | `DELETE /api/auth/cli/session`                              | [auth.ts:117](../apps/cli/src/commands/auth.ts#L117)                                  |
| `mcpOAuthAuthorizationInspect` | `GET /api/auth/mcp/oauth/authorization/:requestId`          | [mcp-authorize.tsx:52](../apps/web/src/routes/mcp-authorize.tsx#L52)                  |
| `mcpOAuthAuthorizationApprove` | `POST /api/auth/mcp/oauth/authorization/:requestId/approve` | [mcp-authorize.tsx:64](../apps/web/src/routes/mcp-authorize.tsx#L64)                  |
| `mcpOAuthAuthorizationDeny`    | `POST /api/auth/mcp/oauth/authorization/:requestId/deny`    | [mcp-authorize.tsx:64](../apps/web/src/routes/mcp-authorize.tsx#L64)                  |

### `billingPublic`

| Operation   | Method and path          | Representative HTTP caller                                                     |
| ----------- | ------------------------ | ------------------------------------------------------------------------------ |
| `listPlans` | `GET /api/billing/plans` | [billing-atoms.ts:25](../apps/web/src/lib/services/atoms/billing-atoms.ts#L25) |

### `errors`

| Operation                  | Method and path                                                   | Representative HTTP caller                                                                                |
| -------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `listIssues`               | `GET /api/errors/issues`                                          | No HTTP caller found                                                                                      |
| `getIssue`                 | `GET /api/errors/issues/:issueId`                                 | No HTTP caller found                                                                                      |
| `transitionIssue`          | `POST /api/errors/issues/:issueId/transitions`                    | [$issueId.tsx:198](../apps/web/src/routes/errors/issues/$issueId.tsx#L198)                                |
| `claimIssue`               | `POST /api/errors/issues/:issueId/claim`                          | [$issueId.tsx:201](../apps/web/src/routes/errors/issues/$issueId.tsx#L201)                                |
| `heartbeatIssue`           | `POST /api/errors/issues/:issueId/heartbeat`                      | [$issueId.tsx:204](../apps/web/src/routes/errors/issues/$issueId.tsx#L204)                                |
| `releaseIssue`             | `POST /api/errors/issues/:issueId/release`                        | [$issueId.tsx:207](../apps/web/src/routes/errors/issues/$issueId.tsx#L207)                                |
| `commentOnIssue`           | `POST /api/errors/issues/:issueId/comments`                       | [$issueId.tsx:210](../apps/web/src/routes/errors/issues/$issueId.tsx#L210)                                |
| `proposeFix`               | `POST /api/errors/issues/:issueId/propose-fix`                    | No HTTP caller found                                                                                      |
| `assignIssue`              | `PUT /api/errors/issues/:issueId/assignee`                        | No HTTP caller found                                                                                      |
| `setIssueSeverity`         | `PUT /api/errors/issues/:issueId/severity`                        | [$issueId.tsx:213](../apps/web/src/routes/errors/issues/$issueId.tsx#L213)                                |
| `listIssueEvents`          | `GET /api/errors/issues/:issueId/events`                          | [$issueId.tsx:166](../apps/web/src/routes/errors/issues/$issueId.tsx#L166)                                |
| `listIssueIncidents`       | `GET /api/errors/issues/:issueId/incidents`                       | No HTTP caller found                                                                                      |
| `listOpenIncidents`        | `GET /api/errors/incidents`                                       | No HTTP caller found                                                                                      |
| `registerAgent`            | `POST /api/errors/agents`                                         | No HTTP caller found                                                                                      |
| `listAgents`               | `GET /api/errors/agents`                                          | No HTTP caller found                                                                                      |
| `getNotificationPolicy`    | `GET /api/errors/policy`                                          | No HTTP caller found                                                                                      |
| `upsertNotificationPolicy` | `PUT /api/errors/policy`                                          | No HTTP caller found                                                                                      |
| `getEscalationPolicy`      | `GET /api/errors/escalation-policy`                               | [escalation-policy-section.tsx:57](../apps/web/src/components/settings/escalation-policy-section.tsx#L57) |
| `upsertEscalationPolicy`   | `PUT /api/errors/escalation-policy`                               | [escalation-policy-section.tsx:65](../apps/web/src/components/settings/escalation-policy-section.tsx#L65) |
| `evaluateEscalationPolicy` | `POST /api/errors/escalation-policy/evaluate`                     | [$issueId.tsx:216](../apps/web/src/routes/errors/issues/$issueId.tsx#L216)                                |
| `listIssueEscalations`     | `GET /api/errors/issues/:issueId/escalations`                     | [$issueId.tsx:191](../apps/web/src/routes/errors/issues/$issueId.tsx#L191)                                |
| `listRecentEscalations`    | `GET /api/errors/escalations/recent`                              | [automation-section.tsx:170](../apps/web/src/components/settings/automation-section.tsx#L170)             |
| `listIssuePullRequests`    | `GET /api/errors/issues/:issueId/pull-requests`                   | [$issueId.tsx:178](../apps/web/src/routes/errors/issues/$issueId.tsx#L178)                                |
| `linkIssuePullRequest`     | `POST /api/errors/issues/:issueId/pull-requests`                  | [$issueId.tsx:222](../apps/web/src/routes/errors/issues/$issueId.tsx#L222)                                |
| `unlinkIssuePullRequest`   | `DELETE /api/errors/issues/:issueId/pull-requests/:pullRequestId` | [$issueId.tsx:225](../apps/web/src/routes/errors/issues/$issueId.tsx#L225)                                |
| `listIssueVerifications`   | `GET /api/errors/issues/:issueId/verifications`                   | [$issueId.tsx:183](../apps/web/src/routes/errors/issues/$issueId.tsx#L183)                                |

### `integrations`

| Operation                | Method and path                                                          | Representative HTTP caller                                                                                  |
| ------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `hazelStatus`            | `GET /api/integrations/hazel/status`                                     | [integration-catalog.tsx:199](../apps/web/src/components/integrations/integration-catalog.tsx#L199)         |
| `hazelStart`             | `POST /api/integrations/hazel/start`                                     | [integration-connect.tsx:293](../apps/web/src/components/integrations/integration-connect.tsx#L293)         |
| `hazelOrganizations`     | `GET /api/integrations/hazel/organizations`                              | [destination-dialog.tsx:312](../apps/web/src/components/alerts/destination-dialog.tsx#L312)                 |
| `hazelChannels`          | `GET /api/integrations/hazel/organizations/:organizationId/channels`     | [destination-dialog.tsx:320](../apps/web/src/components/alerts/destination-dialog.tsx#L320)                 |
| `hazelDisconnect`        | `DELETE /api/integrations/hazel`                                         | [hazel-integration-card.tsx:31](../apps/web/src/components/integrations/hazel-integration-card.tsx#L31)     |
| `cloudflareStatus`       | `GET /api/integrations/cloudflare/status`                                | [use-infra-surfaces.ts:50](../apps/web/src/hooks/use-infra-surfaces.ts#L50)                                 |
| `cloudflareUsage`        | `GET /api/integrations/cloudflare/usage`                                 | [integration-connect.tsx:215](../apps/web/src/components/integrations/integration-connect.tsx#L215)         |
| `cloudflareTopTraffic`   | `POST /api/integrations/cloudflare/top-traffic`                          | [cloudflare-infra.ts:719](../apps/web/src/api/warehouse/cloudflare-infra.ts#L719)                           |
| `cloudflareStart`        | `POST /api/integrations/cloudflare/start`                                | [integration-connect.tsx:219](../apps/web/src/components/integrations/integration-connect.tsx#L219)         |
| `cloudflareDisconnect`   | `DELETE /api/integrations/cloudflare`                                    | [cloudflare-account-card.tsx:386](../apps/web/src/components/integrations/cloudflare-account-card.tsx#L386) |
| `cloudflarePrime`        | `POST /api/integrations/cloudflare/prime`                                | [integration-connect.tsx:222](../apps/web/src/components/integrations/integration-connect.tsx#L222)         |
| `cloudflareHyperdrives`  | `GET /api/integrations/cloudflare/hyperdrive`                            | [service-map-view.tsx:2628](../apps/web/src/components/service-map/service-map-view.tsx#L2628)              |
| `githubStatus`           | `GET /api/integrations/github/status`                                    | [integration-catalog.tsx:204](../apps/web/src/components/integrations/integration-catalog.tsx#L204)         |
| `githubStart`            | `POST /api/integrations/github/start`                                    | [integration-connect.tsx:328](../apps/web/src/components/integrations/integration-connect.tsx#L328)         |
| `githubDisconnect`       | `DELETE /api/integrations/github`                                        | [github-integration-card.tsx:83](../apps/web/src/components/integrations/github-integration-card.tsx#L83)   |
| `githubDeleteRepository` | `DELETE /api/integrations/github/repositories/:repositoryId`             | [github-integration-card.tsx:87](../apps/web/src/components/integrations/github-integration-card.tsx#L87)   |
| `githubSetTrackedBranch` | `PUT /api/integrations/github/repositories/:repositoryId/tracked-branch` | [github-integration-card.tsx:91](../apps/web/src/components/integrations/github-integration-card.tsx#L91)   |
| `vcsCommitDetail`        | `GET /api/integrations/vcs/commits/:sha`                                 | [commit-sha-hover-card.tsx:158](../apps/web/src/components/vcs/commit-sha-hover-card.tsx#L158)              |
| `vcsCommitDetails`       | `GET /api/integrations/vcs/commits`                                      | [commit-sha-hover-card.tsx:172](../apps/web/src/components/vcs/commit-sha-hover-card.tsx#L172)              |
| `vcsPullRequests`        | `GET /api/integrations/vcs/pull-requests`                                | [attach-pull-request-dialog.tsx:115](../apps/web/src/components/errors/attach-pull-request-dialog.tsx#L115) |

### `orgClickHouseSettings`

| Operation           | Method and path                                        | Representative HTTP caller                                                                                              |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `get`               | `GET /api/org-clickhouse-settings`                     | [org-clickhouse-settings-section.tsx:84](../apps/web/src/components/settings/org-clickhouse-settings-section.tsx#L84)   |
| `upsert`            | `PUT /api/org-clickhouse-settings`                     | [org-clickhouse-settings-section.tsx:96](../apps/web/src/components/settings/org-clickhouse-settings-section.tsx#L96)   |
| `schemaDiff`        | `GET /api/org-clickhouse-settings/schema-diff`         | [org-clickhouse-settings-section.tsx:88](../apps/web/src/components/settings/org-clickhouse-settings-section.tsx#L88)   |
| `applySchema`       | `POST /api/org-clickhouse-settings/apply-schema`       | [org-clickhouse-settings-section.tsx:99](../apps/web/src/components/settings/org-clickhouse-settings-section.tsx#L99)   |
| `applySchemaStatus` | `GET /api/org-clickhouse-settings/apply-schema/status` | [org-clickhouse-settings-section.tsx:92](../apps/web/src/components/settings/org-clickhouse-settings-section.tsx#L92)   |
| `collectorConfig`   | `GET /api/org-clickhouse-settings/collector-config`    | No HTTP caller found                                                                                                    |
| `delete`            | `DELETE /api/org-clickhouse-settings`                  | [org-clickhouse-settings-section.tsx:102](../apps/web/src/components/settings/org-clickhouse-settings-section.tsx#L102) |

### `organizations`

| Operation | Method and path             | Representative HTTP caller                                                                      |
| --------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `delete`  | `DELETE /api/organizations` | [organization-section.tsx:55](../apps/web/src/components/settings/organization-section.tsx#L55) |

### `sessionReplays`

| Operation           | Method and path                        | Representative HTTP caller                                      |
| ------------------- | -------------------------------------- | --------------------------------------------------------------- |
| `listReplays`       | `POST /api/session-replays/list`       | [replays.ts:69](../apps/web/src/api/warehouse/replays.ts#L69)   |
| `getReplay`         | `POST /api/session-replays/get`        | [replays.ts:173](../apps/web/src/api/warehouse/replays.ts#L173) |
| `replaysForTrace`   | `POST /api/session-replays/for-trace`  | [replays.ts:335](../apps/web/src/api/warehouse/replays.ts#L335) |
| `sessionTranscript` | `POST /api/session-replays/transcript` | [replays.ts:304](../apps/web/src/api/warehouse/replays.ts#L304) |
