---
title: "Terraform resources"
description: "Every resource and data source in the Maple Terraform provider: arguments, read-only attributes, import IDs and update behavior."
group: "Infrastructure as Code"
order: 4
icon: "terraform"
navLabel: "Terraform resources"
---

The resources the `mapletechlabs/maple` provider manages. New here? Start with the [Terraform quick start](/docs/iac/terraform).

| Resource                                              | Lifecycle                                                           | Import ID |
| ----------------------------------------------------- | ------------------------------------------------------------------- | --------- |
| [`maple_dashboard`](#maple_dashboard)                 | Create, update in place, delete                                     | `dash_…`  |
| [`maple_alert_destination`](#maple_alert_destination) | Create, update in place, delete. Changing `type` replaces it        | `dest_…`  |
| [`maple_alert_rule`](#maple_alert_rule)               | Create, update in place, delete                                     | `alrt_…`  |
| [`maple_uptime_monitor`](#maple_uptime_monitor)       | Create, update in place, delete. Changing `config.type` replaces it | `upm_…`   |
| [`maple_scrape_target`](#maple_scrape_target)         | Create, update in place, delete. Changing `target_type` replaces it | `scrp_…`  |
| [`maple_api_key`](#maple_api_key)                     | Create, roll, revoke. Any other change replaces the key             | `key_…`   |
| [`maple_ingest_keys`](#maple_ingest_keys)             | Data source                                                         |           |

Attribute names are the API's `snake_case` wire names, as the [interactive API reference](https://api.maple.dev/v2/docs) documents the matching create endpoint. Attributes marked **default** take Maple's value when you leave them out, and keep their last value if you remove them later; every other optional attribute is cleared in Maple when you remove it.

## maple_dashboard

```hcl
resource "maple_dashboard" "checkout" {
  name        = "Checkout"
  description = "Golden signals for the checkout flow"
  tags        = ["checkout"]
  time_range  = jsonencode({ type = "relative", value = "12h" })
  widgets = jsonencode([
    {
      id            = "error-rate"
      visualization = "chart"
      data_source   = { kind = "route", endpoint = "traces_timeseries" }
      display       = { title = "Error rate" }
      layout        = { x = 0, y = 0, w = 6, h = 4 }
    },
  ])
}
```

| Argument                   | Type         | Notes                                                                                             |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `name`                     | string       | Required                                                                                          |
| `description`              | string       |                                                                                                   |
| `tags`                     | list(string) |                                                                                                   |
| `time_range`               | JSON         | **default**. `{ type = "relative", value = "12h" }` or an absolute `start_time` and `end_time`    |
| `widgets`                  | JSON         | List of widget documents                                                                          |
| `sections`                 | JSON         | Widgets join one with `section_id` and `tab_id`; their `layout` is relative to the section's grid |
| `variables`                | JSON         | List of dashboard variables                                                                       |
| `refresh_interval_seconds` | number       | 0, 5, 10, 30, 60, 300 or 900                                                                      |

The easiest way to get widget documents is to build the dashboard in Maple and [import it](/docs/iac/terraform#bring-existing-configuration-under-terraform). See [Build dashboards](/docs/dashboards/build-dashboards).

## maple_alert_destination

A notification channel that alert rules and uptime monitors deliver to. The fields depend on `type`:

| `type`      | Fields                                                  |
| ----------- | ------------------------------------------------------- |
| `pagerduty` | `integration_key`                                       |
| `webhook`   | `url`, optional `signing_secret`                        |
| `discord`   | `webhook_url`                                           |
| `telegram`  | `bot_token`, `chat_id`                                  |
| `email`     | `member_user_ids`                                       |
| `chat`      | `workspace_id` of a linked chat workspace, `channel_id` |

Every type also takes `name` (required) and `enabled` (**default** `true`). Credentials are write-only: Terraform sends the value from your configuration on every update and cannot see changes made in Maple. Read-only: `summary`, `channel_label`.

See [Notification destinations](/docs/alerting/notification-destinations).

## maple_alert_rule

```hcl
resource "maple_alert_rule" "checkout_latency" {
  name           = "Checkout p95 latency"
  signal_type    = "p95_latency"
  comparator     = "gt"
  window_minutes = 10
  service_names  = ["checkout"]
  thresholds = jsonencode([
    { severity = "warning", value = 800, destination_ids = [maple_alert_destination.team.id] },
    { severity = "critical", value = 2000, destination_ids = [maple_alert_destination.oncall.id] },
  ])
}
```

| Argument                                                                                                             | Type           | Notes                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `name`                                                                                                               | string         | Required, unique in the organization                                                                                |
| `signal_type`                                                                                                        | string         | Required. `error_rate`, `p95_latency`, `p99_latency`, `apdex`, `throughput`, `builder_query`, `raw_query`, `uptime` |
| `comparator`                                                                                                         | string         | Required. `gt`, `gte`, `lt`, `lte`, `eq`, `neq`, `between`, `not_between`                                           |
| `window_minutes`                                                                                                     | number         | Required, up to 1440                                                                                                |
| `severity`, `threshold`                                                                                              | string, number | **default**. One threshold. Error rates are 0 to 1 ratios                                                           |
| `thresholds`                                                                                                         | JSON           | **default**. Tiers of `{ severity, value, upper, recovery_value, destination_ids }`                                 |
| `threshold_upper`                                                                                                    | number         | Upper bound for `between` and `not_between`                                                                         |
| `destination_ids`                                                                                                    | list(string)   | **default**. `dest_…` IDs                                                                                           |
| `service_names`, `exclude_service_names`, `environments`, `group_by`                                                 | list(string)   | Scope and split the rule                                                                                            |
| `tags`                                                                                                               | set(string)    | Lowercase                                                                                                           |
| `notes`                                                                                                              | string         | Included in notifications                                                                                           |
| `enabled`, `alert_on_no_data`                                                                                        | bool           | **default**                                                                                                         |
| `minimum_sample_count`, `consecutive_breaches_required`, `consecutive_healthy_required`, `renotify_interval_minutes` | number         | **default**                                                                                                         |
| `evaluation_interval_minutes`, `breaches_out_of`                                                                     | number         |                                                                                                                     |
| `apdex_threshold_ms`                                                                                                 | number         | `apdex` rules                                                                                                       |
| `query_builder_draft`                                                                                                | JSON           | `builder_query` rules                                                                                               |
| `raw_query_sql`, `raw_query_reducer`                                                                                 | string         | `raw_query` rules                                                                                                   |
| `notification_template`                                                                                              | JSON           | Custom `title` and `body`, optional per-channel `overrides`                                                         |

Maple checks the signal-specific fields against `signal_type` when you apply. See [Alert rules](/docs/alerting/alert-rules).

## maple_uptime_monitor

```hcl
resource "maple_uptime_monitor" "nightly_backup" {
  name = "Nightly backup"
  config = jsonencode({
    type          = "heartbeat"
    schedule      = { type = "cron", expression = "0 3 * * *", timezone = "Europe/Berlin" }
    grace_seconds = 900
  })
  destination_ids = [maple_alert_destination.oncall.id]
}
```

| Argument           | Type         | Notes                                                              |
| ------------------ | ------------ | ------------------------------------------------------------------ |
| `name`             | string       | Required                                                           |
| `config`           | JSON         | Required. `type` is `http`, `tcp`, `dns` or `heartbeat`; see below |
| `interval_seconds` | number       | **default**. 30 to 3600                                            |
| `failures_to_down` | number       | **default**. 1 to 10                                               |
| `service_name`     | string       | Attach the monitor to a service                                    |
| `enabled`          | bool         | **default** `true`                                                 |
| `destination_ids`  | list(string) | Notified when the monitor goes down or recovers                    |

| `config.type` | Fields                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `http`        | `url`, optional `method` (`GET`, `HEAD`, `POST`), `headers`, `body`, `assertions`, `timeout_ms`             |
| `tcp`         | `host`, `port`, optional `timeout_ms`                                                                       |
| `dns`         | `hostname`, `record_type` (`A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`), optional `expected`                    |
| `heartbeat`   | `schedule` (`{ type = "interval", seconds }` or `{ type = "cron", expression, timezone }`), `grace_seconds` |

Read-only: `kind`, `heartbeat_url` (the URL a heartbeat job pings), `alert_rule_id`. See [Uptime monitoring](/docs/alerting/uptime-monitoring).

## maple_scrape_target

```hcl
resource "maple_scrape_target" "node_exporter" {
  name                    = "node-exporter"
  url                     = "https://metrics.example.com/metrics"
  scrape_interval_seconds = 30
  auth_type               = "bearer"
  auth_credentials        = var.metrics_token
}
```

| Argument                                               | Type                 | Notes                                                    |
| ------------------------------------------------------ | -------------------- | -------------------------------------------------------- |
| `name`                                                 | string               | Required                                                 |
| `url`                                                  | string               | **default**. The metrics endpoint                        |
| `target_type`                                          | string               | **default** `prometheus`. Also `planetscale`, `supabase` |
| `scrape_interval_seconds`                              | number               | **default**. 5 to 300                                    |
| `auth_type`                                            | string               | **default** `none`. Also `bearer`, `basic`, `token`      |
| `auth_credentials`                                     | string               | Write-only                                               |
| `labels_json`                                          | string               | Extra labels, as a JSON object string                    |
| `service_name`                                         | string               | `service.name` for the scraped series                    |
| `organization`, `include_branches`, `exclude_branches` | string, list(string) | `planetscale` targets                                    |
| `enabled`                                              | bool                 | **default** `true`                                       |

See [Prometheus](/docs/integrations/prometheus).

## maple_api_key

| Argument             | Type         | Notes                                                                       |
| -------------------- | ------------ | --------------------------------------------------------------------------- |
| `name`               | string       | Required                                                                    |
| `description`        | string       |                                                                             |
| `scopes`             | list(string) | For example `dashboards:read`, `alerts:write`. Unset means full access      |
| `kind`               | string       | **default** `standard`. Also `mcp`                                          |
| `expires_in_seconds` | number       | Unset means the key does not expire                                         |
| `rotate`             | string       | Any value. Changing it [rolls the key](/docs/iac/terraform#rotate-api-keys) |

Changing anything but `rotate` revokes the key and creates a new one. Read-only: `secret` (sensitive, stored in state), `key_prefix`, `expires_at`. Destroying the resource revokes the key.

## maple_ingest_keys

```hcl
data "maple_ingest_keys" "this" {}
```

Read-only: `public_key` and `private_key` (both sensitive), `public_rotated_at`, `private_rotated_at`. Needs an API key created by an org admin. See [Authentication](/docs/reference/authentication).
