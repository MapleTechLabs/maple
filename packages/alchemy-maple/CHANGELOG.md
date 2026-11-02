# @maple-dev/alchemy

## 0.4.0

### Minor Changes

- 22960ae: `alchemy dev` can run Maple Local for the stack. Declare `Local("observability")` from `@maple-dev/alchemy/local`, register `localProviders()`, and pass it as `Telemetry({ local })`: under `alchemy dev` every Worker exports to one shared loopback server, with no ingest key and no Maple account, and the dashboard opens at `local.maple.dev`. Deploys ignore `local` and use `ingestKey` and `endpoint` as before.

    The server runs in an Alchemy sidecar process, survives stack reloads, and stores data per stack, stage and resource under `.alchemy/maple-local/`. The first run downloads the pinned chDB library, verifies its sha256 and caches it in `~/.maple/cache/libchdb`; `MAPLE_LIBCHDB` points at a copy you already have. Another project on `4318` moves the listener to a free port, and a second `alchemy dev` of the same stack shares the running server. `LocalProps` takes `dataDir`, `port` (binds exactly that port) and `onDirtyStore`: a store left unclean by a killed sidecar is refused unless it is `"wipe"`.

    Requires Bun, and `@effect/platform-bun` as an optional peer dependency (Alchemy already needs it under Bun).

### Patch Changes

- Updated dependencies [1c7c733]
    - @maple-dev/effect-sdk@0.13.1

## 0.3.0

### Minor Changes

- f9ee36c: `AlertRuleProps` is discriminated, so a rule that combines fields the API rejects fails to type-check instead of failing the deploy. By scope: `group_by` and `exclude_service_names` only without `service_names`, and `exclude_service_names` only with `group_by: ["service.name"]`. By `signal_type`: `builder_query` requires `query_builder_draft` and takes no `service_names` or `exclude_service_names`; `raw_query` requires `raw_query_sql`, takes `raw_query_reducer`, and takes no `service_names`, `group_by` or `exclude_service_names`; every other signal takes none of those query fields. By `comparator`: `between` and `not_between` require `threshold_upper`, which no other comparator takes. A grouped rule takes no `alert_on_no_data: true`. A grouped `builder_query` rule takes none either.

    Updates now send `service_names`, `exclude_service_names`, `group_by` and `alert_on_no_data` on every deploy, an undeclared one as its default (`[]`, `[]`, `null`, `false`). Removing one from props clears it instead of keeping the old value next to its replacement.

    Breaking: `AlertRuleProps` is a union, so an `interface` can no longer extend it, and `signal_type` and `comparator` must be literals.

- fc5a796: `Maple.AlertDestination` accepts `type: "google-chat"` with a `webhook_url`, a Google Chat space's incoming webhook.
- b9504b5: `Maple.AlertDestination` accepts `type: "linear"` with a `team_id`, for a team in the Linear workspace connected in Maple.
- d2bbba8: `Maple.Dashboard` props are typed by the API's dashboard schemas, and the package exports them (`DashboardData`, `DashboardWidget`, `DashboardSection`, `DashboardVariable`, `DashboardTimeRange`) so panels and dashboards can be shared as values. `refresh_interval_seconds` is now managed. `dashboardId` adopts an existing dashboard by its ID: a missing ID fails the deploy instead of creating a new dashboard.

### Patch Changes

- Updated dependencies [534647e]
- Updated dependencies [ef33c0d]
- Updated dependencies [41da0c2]
- Updated dependencies [13abd6c]
    - @maple-dev/effect-sdk@0.13.0

## 0.2.5

### Patch Changes

- Updated dependencies [bf01691]
    - @maple-dev/effect-sdk@0.12.1

## 0.2.4

### Patch Changes

- Updated dependencies [af2b366]
- Updated dependencies [75a59ca]
- Updated dependencies [f34141f]
- Updated dependencies [c463f5c]
- Updated dependencies [7216bb9]
    - @maple-dev/effect-sdk@0.12.0

## 0.2.3

### Patch Changes

- Updated dependencies [832b7db]
    - @maple-dev/effect-sdk@0.11.0

## 0.2.2

### Patch Changes

- Updated dependencies [737e082]
    - @maple-dev/effect-sdk@0.10.2

## 0.2.1

### Patch Changes

- Updated dependencies [ed8a412]
    - @maple-dev/effect-sdk@0.10.1

## 0.2.0

### Minor Changes

- Initial release.
