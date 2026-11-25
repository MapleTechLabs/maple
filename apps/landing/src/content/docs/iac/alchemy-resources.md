---
title: "Alchemy resources"
description: "Every Maple resource the Alchemy provider manages: props, outputs and lifecycle for dashboards, alert rules, alert destinations, uptime monitors, status pages, API keys and ingest keys."
group: "Infrastructure as Code"
order: 2
icon: "alchemy"
navLabel: "Alchemy resources"
---

This page lists the resources `@maple-dev/alchemy` manages. If you are new to the package, start with the [Alchemy quick start](/docs/iac/alchemy).

| Resource                                           | Lifecycle                                                           | Main output     |
| -------------------------------------------------- | ------------------------------------------------------------------- | --------------- |
| [`Maple.Dashboard`](#mapledashboard)               | Create, update in place, delete                                     | `dashboardId`   |
| [`Maple.AlertDestination`](#maplealertdestination) | Create, update in place, delete. Changing `type` replaces it        | `destinationId` |
| [`Maple.AlertRule`](#maplealertrule)               | Create, update in place, delete. Ownership-tagged per stack         | `ruleId`        |
| [`Maple.UptimeMonitor`](#mapleuptimemonitor)       | Create, update in place, delete. Changing `config.type` replaces it | `monitorId`     |
| [`Maple.StatusPage`](#maplestatuspage)             | Create, update in place, delete                                     | `statusPageId`  |
| [`Maple.ApiKey`](#mapleapikey)                     | Create, roll, revoke. Any other prop change replaces the key        | `secret`        |
| [`Maple.IngestKeys`](#mapleingestkeys)             | Read-only singleton                                                 | `privateKey`    |

Props use the API's `snake_case` wire shape, exactly as the [interactive API reference](https://api.maple.dev/v2/docs) documents the matching create endpoint. Outputs use `camelCase`.

## Maple.Dashboard

```typescript
Effect.gen(function* () {
	const dash = yield* Maple.Dashboard("checkout", {
		name: "Checkout",
		description: "Golden signals for the checkout flow",
		tags: ["checkout"],
		time_range: { type: "relative", value: "12h" },
		widgets: [/* widget documents */],
		sections: [/* collapsible widget groups */],
		variables: [/* dashboard variables */],
	})
})
```

| Prop                       | Type             | Notes                                                                                             |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `name`                     | `string`         | Required                                                                                          |
| `description`              | `string \| null` |                                                                                                   |
| `tags`                     | `string[]`       |                                                                                                   |
| `time_range`               | `object`         | For example `{ type: "relative", value: "12h" }`                                                  |
| `widgets`                  | `object[]`       | Typed by the API's widget schema (`Maple.DashboardWidget`)                                        |
| `sections`                 | `object[]`       | Widgets join one with `section_id` and `tab_id`; their `layout` is relative to the section's grid |
| `variables`                | `object[]`       | Typed by the API's variable schema (`Maple.DashboardVariable`)                                    |
| `refresh_interval_seconds` | `number \| null` | `0`, `5`, `10`, `30`, `60`, `300` or `900`                                                        |
| `dashboardId`              | `string`         | Adopt an existing `dash_…` dashboard instead of creating one. Cannot change after deploy          |

Outputs: `dashboardId` (`dash_…`), `name`.

The easiest way to get a widget document is to build the dashboard in the UI and copy it from `GET /v2/dashboards/{id}`. See [Build dashboards](/docs/dashboards/build-dashboards).

## Maple.AlertDestination

A notification channel that alert rules deliver to. Props are discriminated on `type`:

| `type`            | Channel fields                                                |
| ----------------- | ------------------------------------------------------------- |
| `pagerduty`       | `integration_key`                                             |
| `webhook`         | `url`, optional `signing_secret`                              |
| `discord`         | `webhook_url`                                                 |
| `telegram`        | `bot_token`, `chat_id`                                        |
| `google-chat`     | `webhook_url`                                                 |
| `microsoft-teams` | `webhook_url` (a Teams Workflows webhook)                     |
| `incident-io`     | `alert_source_config_id`, `token`                             |
| `email`           | `member_user_ids` (Maple user IDs in your org)                |
| `linear`          | `team_id` (a team in the Linear workspace connected in Maple) |

Every variant also takes `name` (required) and `enabled` (defaults to `true` on both create and update).

```typescript
Effect.gen(function* () {
	const hooks = yield* Maple.AlertDestination("incident-webhook", {
		type: "webhook",
		name: "Incident bot",
		url: "https://hooks.example.com/maple",
		signing_secret: Redacted.make(process.env.WEBHOOK_SECRET!),
	})
})
```

- Channel secrets (`integration_key`, `signing_secret`, `webhook_url`, `bot_token`, `token`) are write-only: the API never returns them. Pass them as `Redacted` values so they stay out of logs and plan output. Because they cannot be read back, the provider re-sends them on every update.
- Changing `type` replaces the destination with a new ID.
- Slack and other chat-connector destinations depend on integrations linked in Maple, so manage them in [Notification destinations](/docs/alerting/notification-destinations), not here.
- Deleting a destination that rules still reference fails with a conflict. When the rules live in the same stack, Alchemy deletes them first.

Outputs: `destinationId` (`dest_…`), `name`, `type`, `enabled`, `channelLabel` (the non-secret channel handle, such as a Telegram chat ID, or `null`).

## Maple.AlertRule

```typescript
Effect.gen(function* () {
	yield* Maple.AlertRule("api-p95", {
		name: "API p95 latency",
		severity: "warning",
		signal_type: "p95_latency",
		comparator: "gt",
		threshold: 800,
		window_minutes: 10,
		service_names: ["api"],
		consecutive_breaches_required: 2,
		destination_ids: [oncall.destinationId],
	})
})
```

| Prop                            | Type                      | Notes                                                               |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------- |
| `name`                          | `string`                  | Required. Unique per organization                                   |
| `severity`                      | `"warning" \| "critical"` | Required                                                            |
| `signal_type`                   | `AlertSignalType`         | Required. See values below                                          |
| `comparator`                    | `AlertComparator`         | Required. See values below                                          |
| `threshold`                     | `number`                  | Required. Error rates are 0-1 ratios                                |
| `threshold_upper`               | `number`                  | Required for `between` / `not_between`, and only for them           |
| `window_minutes`                | `number`                  | Required                                                            |
| `destination_ids`               | `string[]`                | Required. `dest_…` IDs, usually `destination.destinationId` outputs |
| `enabled`                       | `boolean`                 |                                                                     |
| `notes`                         | `string \| null`          |                                                                     |
| `service_names`                 | `string[]`                | Only these services. Not with `group_by`                            |
| `exclude_service_names`         | `string[]`                | All services except these. Needs `group_by: ["service.name"]`       |
| `group_by`                      | `string[] \| null`        | One incident per group. Not with `service_names`                    |
| `tags`                          | `string[]`                | Up to 19. `alchemy:` tags are reserved (see below)                  |
| `minimum_sample_count`          | `number`                  |                                                                     |
| `consecutive_breaches_required` | `number`                  | Breaching windows before it fires                                   |
| `consecutive_healthy_required`  | `number`                  | Healthy windows before it resolves                                  |
| `renotify_interval_minutes`     | `number`                  |                                                                     |
| `alert_on_no_data`              | `boolean`                 | Count a window with no data as a breach. Not on grouped rules       |
| `apdex_threshold_ms`            | `number \| null`          | For `apdex` rules                                                   |
| `query_builder_draft`           | `object`                  | Required for `builder_query` rules, passed through verbatim         |
| `raw_query_sql`                 | `string`                  | Required for `raw_query` rules                                      |
| `raw_query_reducer`             | `string \| null`          | `identity`, `sum`, `avg`, `min` or `max`                            |
| `notification_template`         | `object \| null`          |                                                                     |

- `signal_type`: `error_rate`, `p95_latency`, `p99_latency`, `apdex`, `throughput`, `builder_query`, `raw_query`
- `comparator`: `gt`, `gte`, `lt`, `lte`, `eq`, `neq`, `between`, `not_between`

The props type refuses the combinations the API rejects, so they fail to type-check instead of failing the deploy:

- `group_by` and `exclude_service_names` are allowed only without `service_names`.
- `exclude_service_names` is allowed only with `group_by: ["service.name"]`.
- `query_builder_draft` is allowed on `builder_query` rules only, and they require it.
- `raw_query_sql` and `raw_query_reducer` are allowed on `raw_query` rules only. A `raw_query` rule requires the SQL and reads no named services and no `group_by`.
- `threshold_upper` is allowed with `between` and `not_between` only, and they require it.
- `alert_on_no_data` is not allowed on a grouped rule.

Every deploy sends `service_names`, `exclude_service_names`, `group_by` and `alert_on_no_data`, so removing one from props clears it.

The API checks the rest, such as the SQL itself. A failure there fails the deploy with a `400`. See [Alert rules](/docs/alerting/alert-rules) for what each signal measures.

Outputs: `ruleId` (`alrt_…`), `name`, `enabled`.

### Ownership

Each rule carries one `alchemy:<hash>` tag that identifies the stack, stage and logical resource that owns it. The tag uses one of Maple's 20 tag slots, which is why `tags` is capped at 19. The tag is what makes state recovery safe:

- If Alchemy state is lost, the provider finds the rule by name and takes it back only when the ownership tag matches.
- A rule with the same name and no matching tag (created in the UI, or by another stack or stage) fails the deploy instead of being overwritten. To take it over deliberately, wrap the resource in Alchemy's `adopt(true)` or deploy with `--adopt`.
- A stack never deletes a rule another stack has adopted.

Keep the ownership tag intact, and use distinct rule names for different stages that share one Maple organization.

## Maple.UptimeMonitor

```typescript
Effect.gen(function* () {
	const api = yield* Maple.UptimeMonitor("api", {
		name: "API health",
		config: { type: "http", url: "https://api.example.com/health" },
		interval_seconds: 60,
		destination_ids: [oncall.destinationId],
	})
})
```

| Prop               | Type       | Notes                                                                                                  |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------------ |
| `name`             | `string`   | Required                                                                                               |
| `config`           | `object`   | Required. `type` is `http`, `tcp`, `dns`, `multistep` or `heartbeat`; the rest as the API documents it |
| `interval_seconds` | `number`   | 30 to 3600. Unset keeps Maple's value                                                                  |
| `failures_to_down` | `number`   | 1 to 10. Unset keeps Maple's value                                                                     |
| `service_name`     | `string`   | Attach the monitor to a service. Unset means none                                                      |
| `enabled`          | `boolean`  | Defaults to `true`                                                                                     |
| `destination_ids`  | `string[]` | Notified when the monitor goes down or recovers. Unset means none                                      |

Outputs: `monitorId` (`upm_…`), `name`, `kind`, `heartbeatUrl` (heartbeats: the URL your job pings), `alertRuleId`. See [Uptime monitoring](/docs/alerting/uptime-monitoring).

## Maple.StatusPage

```typescript
Effect.gen(function* () {
	const api = yield* Maple.UptimeMonitor("api", {
		name: "API health",
		config: { type: "http", url: "https://api.example.com/health" },
	})
	const page = yield* Maple.StatusPage("status", {
		name: "Acme Status",
		slug: "acme-status",
		support_url: "https://acme.example/support",
		theme: { preset: "midnight", accent: "#a5b4fc" },
		components: [
			{ name: "API", monitor_id: api.monitorId },
			{ name: "Docs", group: "Websites", show_uptime: false },
		],
		custom_domain: "status.acme.example",
	})
	// page.customDomain.dnsRecords: the records to create at your DNS provider
})
```

The props are the page's [config document](https://api.maple.dev/v2/docs) (`PUT /v2/status_pages/{id}/config`), plus `password` and `custom_domain`:

| Prop                                                                    | Type                                   | Notes                                                                                                                           |
| ----------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `slug`                                                          | `string`                               | Required. The page is served at `/s/<org key>/<slug>`                                                                           |
| `description`, `website_url`, `support_url`, `privacy_url`, `terms_url` | `string \| null`                       | Page text and links                                                                                                             |
| `logo_url`, `logo_dark_url`, `favicon_url`                              | `string \| null`                       | An https URL, or a base64 `data:image/...` URL of at most 128 KB                                                                |
| `show_powered_by`                                                       | `boolean`                              | Defaults to `true`                                                                                                              |
| `auto_incidents`                                                        | `"off" \| "draft" \| "publish"`        | Defaults to `off`                                                                                                               |
| `visibility`                                                            | `"public" \| "password" \| "internal"` | Unset keeps the page's visibility (`public` for a new page)                                                                     |
| `theme`                                                                 | `object`                               | `preset`, `appearance`, `accent`, `background`, `text`, `card`, `border`, `radius`, `font`. Unset fields take the default theme |
| `components`                                                            | `object[]`                             | Required, `[]` for none. In display order: `name`, `description`, `group`, `monitor_id`, `manual_status`, `show_uptime`                                  |
| `password`                                                              | `string \| Redacted`                   | Needed for `visibility: "password"`. Write-only to Maple, but kept in Alchemy state: protect the state as a credential          |
| `custom_domain`                                                         | `string`                               | Also serve the page on this hostname. Not allowed on an `internal` page                                                         |

- Components are matched to the page's existing ones by name, so their IDs, incidents and uptime history survive reordering and edits. Renaming a component recreates it; leaving one out deletes it.
- When `manual_status` is unset, an override a responder sets during an incident stays: a deploy does not undo it. Set `manual_status` to `null` to clear the override.
- `password` and `custom_domain` are only managed once declared: removing the prop removes the password or domain.
- A new page is published once it is fully configured, so a half-made page is never served.

Outputs: `statusPageId` (`stp_…`), `name`, `slug`, `components` (`{ componentId, name }[]`, for incidents posted through the API), `customDomain` (`{ hostname, cnameTarget, dnsRecords }` or `null`), `configVersion`. Incidents are operational and are not declared here. See [Status pages](/docs/alerting/status-pages).

## Maple.ApiKey

```typescript
Effect.gen(function* () {
	const ci = yield* Maple.ApiKey("ci", {
		name: "ci-pipeline",
		scopes: ["dashboards:write", "alerts:read"],
		rotate: 1,
	})
	// ci.secret is a Redacted<string>; bind it into another resource's env.
})
```

| Prop                 | Type                  | Notes                                                                                 |
| -------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `name`               | `string`              | Required                                                                              |
| `description`        | `string`              |                                                                                       |
| `scopes`             | `string[]`            | Omit for full access                                                                  |
| `kind`               | `"standard" \| "mcp"` | Defaults to `standard`. `mcp` keys only work on the [MCP server](/docs/reference/mcp) |
| `expires_in_seconds` | `number`              |                                                                                       |
| `rotate`             | `number \| string`    | Bump it (`1` to `2`) to roll the key                                                  |

The API has no update endpoint for keys:

- Changing `name`, `description`, `scopes`, `kind` or `expires_in_seconds` **replaces** the key: a new ID and a new secret, and the old key is revoked.
- Bumping `rotate` **rolls** the key: Maple revokes the old key and issues a replacement with the same name, description, kind and scopes, a new `keyId` and a new secret.
- Deleting the resource revokes the key.

Outputs: `keyId` (`key_…`), `name`, `keyPrefix`, `secret` (`Redacted`, the full `maple_ak_…` value).

The API returns a secret only once, at create or roll time. The provider stores it in Alchemy state, which is the only place it survives, so keep your state somewhere durable and encrypted.

## Maple.IngestKeys

```typescript
Effect.gen(function* () {
	const ingest = yield* Maple.IngestKeys("ingest")
	// ingest.publicKey  -> maple_pk_… for browser and mobile senders
	// ingest.privateKey -> maple_sk_… for server-side senders
})
```

A read-only view of your organization's [ingest keys](/docs/reference/authentication). It takes no props, and there is one per organization. Deleting the resource only stops tracking it; the keys stay valid. Rolling is not modeled, because a roll immediately invalidates the old key for every sender. Roll ingest keys from **Settings → Ingestion** instead.

Outputs: `publicKey`, `privateKey` (both `Redacted`), `publicRotatedAt`, `privateRotatedAt`.

## Drift and sync

- A deploy compares declared props against what the API returns and patches only when they differ. Fields you leave out of props stay unmanaged, so edits to them in the UI are kept.
- An alert rule manages `service_names`, `exclude_service_names`, `group_by` and `alert_on_no_data` even when unset: every deploy sends them, so a value set in the UI is cleared.
- An uptime monitor manages `service_name`, `enabled` and `destination_ids` even when unset (none, `true`, none).
- A status page is the exception to unmanaged fields: it is applied as a whole document, so unset fields take their defaults and a component added in the UI is deleted. Only these are left alone: an unset `manual_status` on a declared component, a `visibility` left unset, and a `password` or `custom_domain` the stack never declared. Removing a declared `password` or `custom_domain` removes it.
- `alchemy sync` restores declared dashboard fields, alert rule configuration and status pages to what the stack declares.
- Alert destination secrets cannot be compared, so drift in them is only caught when you change the prop.

## Errors and retries

The client retries `429` and `5xx` responses with bounded exponential backoff and honors `retry_after_seconds` from the [error envelope](/docs/reference/api#errors). The API allows 600 requests per 60 seconds per key, which a large stack stays well under.

Failures surface as typed errors in Effect's error channel. An API failure is tagged with the server's own `@maple/http/…` error tag and carries the HTTP `status` and the [error body](/docs/reference/api#errors) (`type`, `code`, `message`). `Maple.MapleErrorTags` has the tags to `catchTag` on. Client-side failures are `MapleApiTransportError`, `MapleApiResponseDecodeError`, `MapleApiProtocolError` and `MapleApiRequestEncodingError`. Rule ownership conflicts are `MapleAlertRuleOwnershipError`, and invalid or reserved rule tags are `MapleAlertRuleTagsError`.
