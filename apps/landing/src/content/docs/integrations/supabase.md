---
title: "Supabase"
description: "Authorize a Supabase organization with OAuth. Maple scrapes CPU, memory, disk, and Postgres metrics from every project each minute, and can collect project logs, advisors, and slowest queries."
group: "Integrations"
order: 3.5
---

You connect a Supabase organization once, with an OAuth authorization. Maple lists the organization's projects and scrapes each project's metrics endpoint on the Supabase Management API every minute. You choose per project whether Maple also collects logs, either by polling or through a Supabase log drain. The data appears under **Infrastructure → Supabase** and in the [metrics explorer](/docs/explore/metrics). You do not run an agent.

## Prerequisites

- Permission in the Supabase organization to authorize an OAuth application.
- A Supabase Pro plan or higher, only if you want log drains.

For self-hosted Supabase, scrape its metrics endpoint as a [Prometheus source](/docs/integrations/prometheus) instead.

## 1. Authorize Maple

Open **Sources** in Maple, click **Connect source**, and pick **Supabase**. The **Sign in with Supabase** step opens. Click **Continue with Supabase**. Supabase opens in a new window.

1. Pick the organization that owns your projects.
2. Review the read scopes: projects, analytics, and database.
3. Click **Authorize**. The Maple tab picks it up on its own.

One authorization covers one organization. If it covers none or more than one, Maple refuses it and asks you to reconnect and pick one. To watch a different organization, click **Authorize again** and pick it in the Supabase window.

Access is read-only. Maple only writes to Supabase when you turn on a log drain. You can revoke access in Supabase under **Organization → OAuth Apps**.

## 2. Choose projects and signals

The next step asks **Which projects in** your organization **should Maple watch?** Each project has three switches. They save as you flip them.

| Switch      | What it does                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Metrics** | Scrapes the project's metrics endpoint every minute. On by default for every project.                                                    |
| **Logs**    | Polls the project's logs every minute through your grant. Off by default. Counts toward ingest.                                          |
| **Drain**   | Creates a Supabase log drain that pushes the project's logs to Maple. Off by default. Needs a Pro plan, and Supabase bills it per drain. |

A project gets its logs from polling or from a drain, not both. Turning on a drain stops polling for that project. If a project already sends logs to Maple through a drain you set up in Supabase, Maple keeps using it and does not let you add a second one.

You can change every switch later on the Supabase card under **Sources**.

## How collection works

- **Projects.** Maple refreshes the project list every hour. New projects start with **Metrics** on. Click **Sync now** on the card to refresh right away.
- **Metrics.** Scraped every minute per project. Supabase allows 10 metrics requests a minute per project, so one a minute leaves headroom. Paused, pausing, removed, and failed projects are not scraped.
- **Polled logs.** Read every minute and kept one minute behind real time, since logs land late. Turning logs on reads the previous 5 minutes.
- **Log drains.** Supabase sends logs as they are written. The drain is visible in Supabase under **Project Settings → Log Drains**.
- **Advisors.** Maple reads each running project's security and performance advisors every hour.
- **Slowest queries.** Maple reads the top 10 statements by total time from `pg_stat_statements` every 15 minutes, as Supabase's read-only database user. Statements from Supabase's own service roles are left out.

## Verify

1. The **Go live** step shows a checklist. **Access works** and **Projects found** complete first. **First metrics** completes when every project with **Metrics** on reports, usually within 2 minutes. If logs are on, **First logs** turns into **Logs flowing**.
2. Open **Infrastructure → Supabase** to see your projects.
3. In the [metrics explorer](/docs/explore/metrics), search for `pg_stat_database_` or `node_memory_` and filter by `supabase.project.name`.

## What you get

### Infrastructure → Supabase

The list page has a stat rail with **Projects**, **API requests**, **Errors and warnings**, and **Storage**. Below it, one row per project: **Status**, **CPU**, **Memory**, **Disk**, **Connections**, **Req / min**, **Issues**, and **Collecting**. **Top errors across projects** and **Advisor findings** follow. API requests, errors, and warnings come from project logs, so they need **Logs** or **Drain** turned on.

Each project's status is one of:

| Status       | Meaning                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Healthy**  | Running, and no signal crosses a limit.                                                                                                              |
| **Degraded** | CPU, memory, or disk peaked at 90% or more, connections reached 90% of `max_connections`, or 5% or more of at least 20 API requests failed with 5xx. |
| **Paused**   | Supabase reports the project as paused or pausing.                                                                                                   |
| **No data**  | No metrics for the project yet.                                                                                                                      |

Other Supabase states show under their own name, for example **Unhealthy**.

Click a project for its page. It shows **CPU**, **Memory**, **Disk**, **Connections**, **Cache hit**, and **Database size**, then charts for **Connections** and **Transactions / s**, **Slowest queries**, **API requests** with **Top paths**, **Errors and warnings**, and **Needs attention** for advisor findings and log issues. **Services calling this project** lists your instrumented services whose client spans call the project's API or its pooler, with a link to the [service map](/docs/explore/service-map). **Open in Supabase** opens the project in Supabase.

### Metrics

Maple stores the metrics endpoint's Prometheus series under the service name `supabase`. Every series carries `supabase_project_ref` and `service_type` (`db`, `postgresql`, `postgrest`, or `gotrue`), plus `supabase.project.ref`, `supabase.project.name`, `supabase.project.region`, and `supabase.organization.slug`. The main metrics:

| Metric                                                                       | What it tells you                                               |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `node_cpu_seconds_total`                                                     | CPU time by mode. Maple derives CPU busy from it.               |
| `node_memory_MemTotal_bytes`, `node_memory_MemAvailable_bytes`               | Memory size and what is free.                                   |
| `node_filesystem_size_bytes`, `node_filesystem_avail_bytes`                  | Disk size and free space. Maple reads the `/data` mount.        |
| `pg_database_size_bytes`                                                     | Size of each database, by `datname`.                            |
| `pg_stat_database_num_backends`                                              | Postgres backends (connections).                                |
| `max_connections_connection_count`                                           | Postgres `max_connections`.                                     |
| `pgbouncer_used_clients`                                                     | Pooler clients.                                                 |
| `pg_stat_database_xact_commit_total`, `pg_stat_database_xact_rollback_total` | Commits and rollbacks.                                          |
| `pg_stat_database_blks_hit_total`, `pg_stat_database_blks_read_total`        | Buffer cache hits and reads. Maple derives the cache hit ratio. |
| `pgrst_db_pool_max`, `pgrst_db_pool_available`, `pgrst_db_pool_waiting`      | PostgREST's database pool.                                      |

Chart and alert on them like any other metric.

### Logs

Polled logs arrive as OpenTelemetry log records under the service name `supabase`, with the same `supabase.project.*` resource attributes. Each record carries `supabase.log.source` (for example `postgres_logs` or `edge_logs`) and its Supabase log attributes. Severity comes from Postgres' error severity, the service's level, or the HTTP status code. Search them in the [logs explorer](/docs/explore/logs).

## Troubleshooting

- **The card shows Access revoked.** Supabase no longer accepts Maple's access, so discovery, metrics, and log polling are paused. Log drains live in Supabase and keep sending. Click **Reconnect**.
- **The card shows Needs attention.** The last project discovery failed. The card shows the error.
- **A drain cannot be turned on.** Log drains need a Supabase Pro plan or higher.
- **A drain shows an error.** If it was removed in Supabase, turn **Drain** off and on again to recreate it.
- **A project shows No data.** Check that **Metrics** is on and the project is running.

## Disconnect

On the Supabase card, click **Disconnect** and confirm. Maple deletes the log drains it created, revokes its access to your Supabase organization, and stops collecting from its projects. Data already collected stays. You can reconnect later.

## Next steps

- [Alert rules](/docs/alerting/alert-rules): alert on project metrics.
- [Logs explorer](/docs/explore/logs): search Supabase logs.
