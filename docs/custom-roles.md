# Roles, permissions and custom roles

## How it works

- Every check reads a permission, never a role. The catalog, built-in role presets and custom role
  storage live in `packages/domain/src/policy/` (`permissions.ts`, `roles.ts`, `custom-roles.ts`;
  `index.ts` has `grantsOf`, `can`, `check`, `denialFor`).
- Built-in roles are Clerk roles: `org:analyst`, `org:member`, `org:engineer`, `org:admin`.
- A custom role is stored in Clerk, not Postgres:
    - definitions in the organization's public metadata, key `maple_roles`, versioned;
    - a member on one holds the Clerk role `org:custom`, and their membership's public metadata
      (`maple_role`) holds the role id and a copy of its permission codes.
- Only Maple's backend writes either (`RolesService`, `ClerkRolesGateway`). `org:custom` with
  nothing on the membership holds no permissions; it can still open settings pages that need none.
- Enforcement: `EndpointAccess` on HTTP endpoints (`packages/domain/src/http/endpoint-access.ts`),
  `permission` on MCP tools, and `MembershipRevocationService.demoteMembership` retiring
  credentials, links, digests and phones a narrower role no longer covers.

## Roles limited to namespaces

A custom role can be limited to a list of `service.namespace` values (`policy/data-scope.ts`). It
then holds `telemetry:read_scoped` in place of `telemetry:read`, and nothing else that reads
telemetry or the warehouse (`holdableWhenScoped`: billing is out too, since it reads the org's
usage). The namespaces are stored on the role, copied onto each holder's membership beside the
permission codes, and carried on the tenant (`TenantContext.namespaces`). Up to 20 per role, 64
characters each, made of letters, digits, spaces and `. _ : / @ + -`.

- **Refused by default.** Everything that checks `telemetry:read` refuses a limited role: every
  endpoint, MCP tool, Electric shape, chat route, push, digest and share link. A tenant that holds
  the scoped permission without its namespaces (a pinned key, a builder that dropped them) reads
  none. Stored codes that name the scoped permission beside one that needs all telemetry decode
  as limited.
- **Opted in per endpoint.** An endpoint marked `ScopedTelemetry` (`http/endpoint-access.ts`)
  accepts the scoped permission where it asks for `telemetry:read`. Mark one only when all the
  telemetry it returns comes from datasources in `SCOPED_DATASOURCES`: rows read from Postgres, a
  provider's API or a shared feed are not filtered. `endpoint-access.test.ts` lists every marked
  endpoint.
- **Filtered in the warehouse.** The auth layers hand the handler its tenant through
  `provideRequestTenant`, which sets `CurrentDataScope` for the whole request. `WarehouseQueryService`
  then runs every read on an org token whose row filters keep each datasource to the namespaces
  (`services/warehouse/data-scope.ts`), whichever tenant the read is made as. Anything else is
  refused (`telemetry_scope_denied`, 403): a datasource that is not listed, and every read where
  no such token exists (an organization on its own ClickHouse, a vanilla ClickHouse, a deployment
  without the Tinybird signing key).
- **A datasource is listed only when every row carries its own namespace**: a `ServiceNamespace`
  column, or resource attributes. A service name is not enough: two namespaces can share one, and
  whoever can send telemetry can claim one. `trace_index` is the exception, a locator: it holds
  trace ids and time buckets, is read org-wide, and only by queries Maple compiled, which use it to
  seek into `traces` (`data-scope.test.ts` holds that no compiled query answers with its rows).
- **Caches.** A limited request files its `EdgeCacheService` entries under a partition of its own
  (`CachePartition`), so it is never served an answer cached for someone who reads everything.
  Shared state (org warehouse config, billing customer, flags, regions) is read through
  `sharedAcrossPartitions`, outside any partition.

## Clerk instance requirements

- Role `org:custom` exists, is in each organization's role set, and holds only
  `org:sys_memberships:read`.
- `org:engineer` and `org:analyst` hold no `org:sys_memberships:manage`: members are changed
  through Maple, which keeps custom role metadata in step.
- Production needs Clerk's B2B Authentication add-on for custom roles.
- The `organizationMembership.*` webhook events are enabled (`/webhooks/clerk`): they demote
  pinned credentials and evict cached memberships.
- Change roles in Maple, not in the Clerk dashboard. A member set back to `org:custom` by hand is
  checked by the webhook against the role their `maple_role` names: a deleted role leaves them with
  nothing and a narrowed one with its current permissions.

## Known limits

- A role limited to namespaces reaches only the endpoints marked `ScopedTelemetry`: the trace list
  and trace detail, logs, metric charts and the services overview. Rollups that only name a
  service stay closed to it until they carry a namespace column: errors, the metric list,
  per-operation and per-endpoint service pages, usage, attribute autocomplete. So do alerts,
  incidents, investigations, dashboards, the service map, session replays, product analytics, raw
  SQL, MCP and Maple AI.
- The Slack and Hazel bots have no identity link: with "Answer questions" on they answer anyone
  in the channel from every namespace, a limited member included.
- A credential minted while a role change has not reached every cache (a session token lives about
  a minute, a cached membership up to five) pins the grants held before it. Limiting someone's role
  retires what they held then, not a key they mint in that window.
- Telemetry sent without a `service.namespace` belongs to no namespace: no limited role reads it.
- The trace list pages by root span, so a trace that starts in another namespace is not listed for
  a limited role, even when some of its spans are in the role's namespaces. Opened by id, it shows
  those spans.
- A limited role opening a trace sees only the spans its namespaces emitted; spans of other
  namespaces in the same trace are missing, not redacted in place. It can learn that a trace id
  exists and when, from the trace index.
- A build that predates namespaces drops them from every role it rewrites: after a rollback, limited
  roles read nothing until saved again.
- Every role write in Maple holds a per-org Postgres advisory lock (`RoleWriteLock`), so two admins
  saving at once take turns. A change made in the Clerk dashboard in between is still possible:
  writes stay version-checked, and the holder reconcile repeats until holders match the latest
  stored definition (three passes, then `concurrent_edit`).
- A holder Clerk refuses to rewrite does not stop the others; the save then fails with
  `roles_unavailable`, and sending the same save again finishes the remaining holders.
- Membership answers are cached up to 5 minutes (shared) and 60 s (per isolate). A narrowing
  evicts the shared entry and the handling isolate's memo; other isolates keep the old permissions
  up to 60 s, and everything up to 5 minutes if the eviction never ran.
- Escalation steps page whoever they name, regardless of that person's permissions.
- Every permission implies Read telemetry unless it is marked `readsNoTelemetry` (billing, own
  devices, MCP and restricted keys, the support channel, status page updates, the public ingest
  key). A role without Read telemetry is for those jobs only.
- PR review replies on a private repository answer anyone who can comment there, with telemetry
  tools: repository access is the gate, not the commenter's Maple role.
