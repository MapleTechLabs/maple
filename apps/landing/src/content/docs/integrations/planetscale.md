---
title: "PlanetScale"
description: "Connect a PlanetScale organization to Maple. Maple discovers every database branch's metrics endpoint, scrapes connections, WAL size, and pod CPU, and adds your databases to the service map."
group: "Integrations"
order: 3
---

PlanetScale publishes Prometheus metrics per database branch behind a [service-discovery API](https://planetscale.com/docs/vitess/integrations/prometheus). One organization endpoint returns the current list of branch metrics targets, and that list changes as branches are created and deleted. You connect the organization once. Maple runs the discovery call, scrapes every branch it returns, and refreshes the branch list every 10 minutes.

Setup has two parts. An OAuth authorization covers the management plane: database inventory, query insights, and webhooks. PlanetScale serves branch metrics only to service tokens, so you add a service token to turn on metrics.

## Prerequisites

- Permission in the PlanetScale organization to authorize an OAuth application and create a service token.

## 1. Authorize Maple

Open **Integrations → PlanetScale** in Maple and click **Connect PlanetScale**. A popup takes you to PlanetScale to authorize Maple's OAuth application. You can revoke access from PlanetScale at any time.

- If the authorization covers one organization, Maple binds it automatically.
- If it covers several, pick one. You can also set **Only these branches (optional)** and **Exclude branches (optional)**. Both take glob patterns, where `*` matches any run of characters and `?` matches exactly one (for example `pr-*, preview-*`).

To switch organizations later, click **Change organization**.

The OAuth application needs `read_databases` for the database inventory, the service map, and query insights. If it is missing, the **Permissions** step shows **Reauthorize with read_databases**.

## 2. Add a service token for branch metrics

After authorization the card shows a four-step checklist: **Authorization**, **Permissions**, **Branch metrics access**, and **Metrics arriving**. The **Branch metrics access** step asks for a service token. If the OAuth authorization already covers the metrics endpoints, this step completes without one.

1. Click **Create a token in PlanetScale**. Create a service token with the `read_metrics_endpoints` organization permission. No other permission is needed.
2. Paste the **Service token ID** and **Service token secret** into Maple.
3. Click **Enable metrics**.

The secret is encrypted at rest. Maple derives the discovery URL (`https://api.planetscale.com/v1/organizations/{org}/metrics`), authenticates discovery and every scrape with the token, and scrapes each branch as its own target. New branches are picked up on the next discovery refresh. Deleted branches stop being scraped.

To replace the token later, click **Rotate token**.

## 3. Optional: webhooks

Under **Webhooks**, click **Show setup** to reveal an endpoint URL and signing secret. Register them in each database's webhook settings on PlanetScale. Only Maple organization admins can view the secret.

## Verify

1. The **Metrics arriving** step changes from **Waiting for the first scrape.** to done, and the checklist collapses to a single health row reading **Streaming branch metrics from** your organization. The card polls while it waits, so you do not need to reload.
2. Open **Infrastructure → PlanetScale** to see your databases and branches.
3. In the [metrics explorer](/docs/explore/metrics), search for `planetscale_` to see branch series.

## What you get

Each branch series carries PlanetScale's discovery labels. The most useful is `planetscale_database_branch_id`, which keys every series to a branch. Highlights from the metric set ([Postgres](https://planetscale.com/docs/postgres/monitoring/prometheus-postgres), [Vitess](https://planetscale.com/docs/vitess/integrations/prometheus)):

| Metric                                         | What it tells you                                          |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `planetscale_postgres_connection_state`        | Connections by state (active, idle, idle in transaction).  |
| `planetscale_edge_postgres_active_connections` | Active connections at the edge.                            |
| `planetscale_postgres_wal_size_bytes`          | WAL size. An early warning for replication and disk usage. |
| `planetscale_pgbouncer_current_connections`    | PgBouncer pool utilization.                                |
| `planetscale_pods_cpu_util_percentages`        | CPU per pod backing the branch.                            |
| `planetscale_vtgate_total_pods`                | (Vitess) vtgate pods per availability zone.                |

Group dashboards and [alert rules](/docs/alerting/alert-rules) by `planetscale_database_branch_id`. For example, alert when WAL size passes a threshold or active connections approach your pool limit.

## Troubleshooting

- **Metrics arriving shows "The last scrape failed."** The health row shows the error. A failure for one branch is prefixed with `[branch:<id>]`.
- **401 or 403 on discovery or scrapes.** The service token was deleted or lacks `read_metrics_endpoints`. Click **Rotate token** and paste a new one.
- **Authorization shows as revoked.** Click **Reconnect** to authorize again.
- **Metrics stopped arriving.** The **Metrics arriving** step reports a stall after three scrape intervals without data. Check the error on the health row.
- **A discovery call fails.** Maple keeps scraping the last known branch list and shows the discovery error on the target, so branch metrics do not drop out during a PlanetScale API outage.
- **Branch filters did not apply.** Changes take effect on the next scrape because the cached branch list is cleared on save.

## Next steps

- [Service map](/docs/explore/service-map): PlanetScale databases linked to the services that query them.
- [Prometheus scraping](/docs/integrations/prometheus): how scraped samples become OpenTelemetry metrics.
- [Alert rules](/docs/alerting/alert-rules): alert on branch metrics.
