---
title: "Alchemy resources"
description: "Every Maple resource the Alchemy provider manages: props, outputs and lifecycle for dashboards, alert rules, alert destinations, API keys and ingest keys."
group: "Infrastructure as Code"
order: 2
icon: "alchemy"
navLabel: "Alchemy resources"
---

The resources `@maple-dev/alchemy` manages. New here? Start with the [Alchemy quick start](/docs/iac/alchemy).

| Resource                                           | Lifecycle                                                    | Main output     |
| -------------------------------------------------- | ------------------------------------------------------------ | --------------- |
| [`Maple.Dashboard`](#mapledashboard)               | Create, update in place, delete                              | `dashboardId`   |
| [`Maple.AlertDestination`](#maplealertdestination) | Create, update in place, delete. Changing `type` replaces it | `destinationId` |
| [`Maple.AlertRule`](#maplealertrule)               | Create, update in place, delete. Ownership-tagged per stack  | `ruleId`        |
| [`Maple.ApiKey`](#mapleapikey)                     | Create, roll, revoke. Any other prop change replaces the key | `secret`        |
| [`Maple.IngestKeys`](#mapleingestkeys)             | Read-only singleton                                          | `privateKey`    |

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

| Prop          | Type             | Notes                                                                                             |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `name`        | `string`         | Required                                                                                          |
| `description` | `string \| null` |                                                                                                   |
| `tags`        | `string[]`       |                                                                                                   |
| `time_range`  | `object`         | e.g. `{ type: "relative", value: "12h" }`                                                         |
| `widgets`     | `object[]`       | Passed through verbatim                                                                           |
| `sections`    | `object[]`       | Widgets join one with `section_id` and `tab_id`; their `layout` is relative to the section's grid |
| `variables`   | `object[]`       | Passed through verbatim                                                                           |

Outputs: `dashboardId` (`dash_…`), `name`.

The easiest way to get a widget document is to build the dashboard in the UI and copy it from `GET /v2/dashboards/{id}`. See [Build dashboards](/docs/dashboards/build-dashboards).

## Maple.AlertDestination

A notification channel that alert rules deliver to. Props are discriminated on `type`:

| `type`      | Channel fields                                                |
| ----------- | ------------------------------------------------------------- |
| `pagerduty` | `integration_key`                                             |
| `webhook`   | `url`, optional `signing_secret`                              |
| `discord`   | `webhook_url`                                                 |
| `telegram`  | `bot_token`, `chat_id`                                        |
| `email`     | `member_user_ids` (Maple user IDs in your org)                |
| `linear`    | `team_id` (a team in the Linear workspace connected in Maple) |

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

- Channel secrets (`integration_key`, `signing_secret`, `webhook_url`, `bot_token`) are write-only: the API never returns them. Pass them as `Redacted` values so they stay out of logs and plan output. Because they cannot be read back, the provider re-sends them on every update.
- Changing `type` replaces the destination with a new ID.
- Slack and other chat-connector destinations depend on integrations linked in Maple, so manage them in [Notification destinations](/docs/alerting/notification-destinations), not here.
- Deleting a destination that rules still reference fails with a conflict. When the rules live in the same stack, Alchemy deletes them first.

Outputs: `destinationId` (`dest_…`), `name`, `type`, `enabled`.

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

The props type refuses the combinations the API rejects, so they fail to type-check instead of failing the deploy: `group_by` and `exclude_service_names` only without `service_names`, and `exclude_service_names` only with `group_by: ["service.name"]`; `query_builder_draft` on `builder_query` only, which requires it; `raw_query_sql` and `raw_query_reducer` on `raw_query` only, which requires the SQL and reads no named services and no `group_by`; `threshold_upper` with `between` and `not_between` only, which require it; and no `alert_on_no_data` on a grouped rule. Every deploy sends `service_names`, `exclude_service_names`, `group_by` and `alert_on_no_data`, so removing one from props clears it. The API checks the rest, such as the SQL itself, and a failure there fails the deploy with a `400`. See [Alert rules](/docs/alerting/alert-rules) for what each signal measures.

Outputs: `ruleId` (`alrt_…`), `name`, `enabled`.

### Ownership

Each rule carries one `alchemy:<hash>` tag that identifies the stack, stage and logical resource that owns it. It uses one of Maple's 20 tag slots, which is why `tags` is capped at 19. The tag is what makes state recovery safe:

- If Alchemy state is lost, the provider finds the rule by name and takes it back only when the ownership tag matches.
- A rule with the same name and no matching tag (created in the UI, or by another stack or stage) fails the deploy instead of being overwritten. To take it over deliberately, wrap the resource in Alchemy's `adopt(true)` or deploy with `--adopt`.
- A stack never deletes a rule another stack has adopted.

Keep the ownership tag intact, and use distinct rule names for different stages that share one Maple organization.

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
- Bumping `rotate` **rolls** the key in place: same ID, name and scopes, new secret.
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
- `alchemy sync` restores declared dashboard fields and alert rule configuration to what the stack declares.
- Alert destination secrets cannot be compared, so drift in them is only caught when you change the prop.

## Errors and retries

The client retries `429` and `5xx` responses with bounded exponential backoff and honors `retry_after_seconds` from the [error envelope](/docs/reference/api#errors). The API allows 600 requests per 60 seconds per key, which a large stack stays well under.

Failures surface as typed errors in Effect's error channel. An API failure is tagged with the server's own `@maple/http/…` error tag and carries the HTTP `status` and the [error body](/docs/reference/api#errors) (`type`, `code`, `message`); `Maple.MapleErrorTags` has the tags to `catchTag` on. Client-side failures are `MapleApiTransportError`, `MapleApiResponseDecodeError`, `MapleApiProtocolError` and `MapleApiRequestEncodingError`. Rule ownership conflicts are `MapleAlertRuleOwnershipError`, and invalid or reserved rule tags are `MapleAlertRuleTagsError`.
