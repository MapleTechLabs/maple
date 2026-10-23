---
title: "PlanetScale"
description: "Connect a PlanetScale organization to Maple with one authorization. Maple collects every branch's CPU, memory, storage, connections, and replica lag, registers webhooks, and adds your databases to the service map."
group: "Integrations"
order: 3
---

You connect a PlanetScale organization once, with an OAuth authorization. It covers everything Maple reads: the database inventory, query insights, branch metrics from PlanetScale's [metrics API](https://planetscale.com/docs/api/reference/get_branch_metrics), and the webhooks Maple registers for you. Maple reads every branch's metrics every 5 minutes, and picks up new branches and databases on its own.

## Prerequisites

- Permission in the PlanetScale organization to authorize an OAuth application and manage database webhooks.

## 1. Authorize Maple

Open **Integrations → PlanetScale** in Maple and click **Connect PlanetScale**. A popup takes you to PlanetScale to authorize Maple's OAuth application. You can revoke access from PlanetScale at any time.

- If the authorization covers one organization, Maple binds it automatically.
- If it covers several, pick one. You can also set **Only these branches (optional)** and **Exclude branches (optional)**. Both take glob patterns, where `*` matches any run of characters and `?` matches exactly one (for example `pr-*, preview-*`).

To switch organizations later, click **Change organization**.

The OAuth application needs `read_databases` for the database inventory, the service map, and query insights. If it is missing, the **Permissions** step shows **Reauthorize with read_databases**.

## 2. Branch metrics

After authorization the card shows a checklist: **Authorization**, **Permissions**, and **Metrics arriving**. Nothing else is asked of you. Within 5 minutes Maple reads each branch's last minutes from the metrics API and the last step completes.

Maple reads every ready branch that passes your branch filters. For Postgres branches that is pod CPU and memory, disk usage and free space, PgBouncer connections, WAL size, and replica lag. For Vitess branches it is connections and router (vtgate) CPU and memory per zone; the metrics API serves no pod or disk metrics for Vitess.

Connections set up with a service token before the metrics API existed keep scraping PlanetScale's Prometheus endpoints with it, and the card shows **Streaming branch metrics** as before.

## 3. Webhooks

Maple registers a webhook on every database in the organization, including databases you create later, within a few minutes. Out-of-memory restarts, storage thresholds, and anomalies open triage issues, and deploy requests and branch changes appear on the charts as they happen. The **Webhooks** row shows how many databases have one.

Registering webhooks needs the `write_databases` access. If you connected before Maple asked for it, the row reads **Needs attention**; click **Reauthorize**. Maple only creates, re-enables, and deletes its own webhook and leaves your other webhooks alone. PlanetScale allows 5 webhooks per database, so a database that already has 5 shows the error on the row. Disconnecting removes Maple's webhooks.

## Verify

1. The **Metrics arriving** step changes from **Waiting for the first poll.** to done, and the checklist collapses to a single health row reading **Streaming branch metrics from** your organization. The card polls while it waits, so you do not need to reload.
2. Open **Infrastructure → PlanetScale** to see your databases and branches.
3. In the [metrics explorer](/docs/explore/metrics), search for `planetscale_` to see branch series.

## What you get

Each branch series carries `planetscale_organization_name`, `planetscale_database_name`, `planetscale_branch_name`, and `planetscale_database_branch_id`, which keys every series to a branch. Series read from the metrics API also carry `planetscale_source="api"`. The main metrics:

| Metric                                     | What it tells you                                                     |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `planetscale_pods_cpu_util_percentages`    | (Postgres) CPU of the pods backing the branch.                        |
| `planetscale_pods_mem_util_percentages`    | (Postgres) Memory of the pods backing the branch.                     |
| `planetscale_volume_available_bytes`       | (Postgres) Free disk space, with `planetscale_volume_capacity_bytes`. |
| `planetscale_postgres_wal_size_bytes`      | (Postgres) WAL size. An early warning for replication and disk usage. |
| `planetscale_postgres_replica_lag_seconds` | (Postgres) Replica lag, one series per replica.                       |
| `planetscale_api_connections`              | Connections (PgBouncer on Postgres, the router on Vitess).            |
| `planetscale_vtgate_cpu_util_percentages`  | (Vitess) Router CPU per availability zone.                            |

Connections that scrape with a service token get PlanetScale's full [Prometheus metric set](https://planetscale.com/docs/vitess/integrations/prometheus) instead.

Group dashboards and [alert rules](/docs/alerting/alert-rules) by `planetscale_database_branch_id`. For example, alert when WAL size passes a threshold or active connections approach your pool limit.

## Troubleshooting

- **Metrics arriving shows an error.** The health row shows what the last poll hit. A failing branch costs only its own window; the others keep arriving.
- **Authorization shows as revoked.** Click **Reconnect** to authorize again.
- **Metrics stopped arriving.** The **Metrics arriving** step reports a stall after 20 minutes without a poll. Check the error on the health row.
- **A new branch has no metrics yet.** Maple reads the branch list from the hourly inventory, so a new branch starts reporting within the hour.
- **Branch filters did not apply.** Changes take effect on the next poll.

## Next steps

- [Service map](/docs/explore/service-map): PlanetScale databases linked to the services that query them.
- [Alert rules](/docs/alerting/alert-rules): alert on branch metrics.
