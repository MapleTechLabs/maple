---
title: "PlanetScale"
description: "Connect a PlanetScale organization to Maple with a service token — Maple discovers every database branch's Prometheus endpoint automatically and scrapes connections, WAL size, and pod CPU."
group: "Integrations"
order: 2
---

PlanetScale publishes per-database-branch Prometheus metrics behind a [service-discovery API](https://planetscale.com/docs/vitess/integrations/prometheus): a single organization endpoint returns the current list of branch metrics targets, which changes as branches are created and destroyed. Maple supports this natively — you connect the **organization** once, and Maple's scrape agent runs the discovery call, scrapes every branch endpoint it returns, and refreshes the branch list automatically (every 10 minutes). No Prometheus server or `remote_write` pipeline needed.

## 1. Create a service token

In the PlanetScale dashboard, create a **service token** for your organization and grant it the `read_metrics_endpoints` organization permission. Note both parts — the token **ID** and the token **secret** (the secret is shown only once).

## 2. Connect the organization in Maple

Open **Integrations → PlanetScale** in the Maple dashboard and click **Add Target**:

- **Name** — display name, e.g. `PlanetScale Prod`
- **Organization** — your PlanetScale organization name (as it appears in the dashboard URL)
- **Service Token ID / Secret** — from step 1; encrypted at rest, never sent to the browser again
- **Scrape Interval** — defaults to 30 seconds, matching PlanetScale's documented Prometheus configuration

That's it. Maple derives the discovery URL (`https://api.planetscale.com/v1/organizations/{org}/metrics`), authenticates with the `Authorization: token {ID}:{SECRET}` scheme PlanetScale expects, and expands the result into one scrape loop per database branch. New branches start being scraped within a discovery refresh; deleted branches stop cleanly.

The **Test** button probes the discovery endpoint — a failure here almost always means the token is wrong or missing the `read_metrics_endpoints` permission.

## What you get

Each discovered branch is scraped as its own instance, labeled with PlanetScale's own discovery labels — most usefully `planetscale_database_branch_id`, which keys every series to a branch. Highlights from the metric set ([Postgres](https://planetscale.com/docs/postgres/monitoring/prometheus-postgres) · [Vitess](https://planetscale.com/docs/vitess/integrations/prometheus)):

| Metric                                         | What it tells you                                         |
| ---------------------------------------------- | --------------------------------------------------------- |
| `planetscale_postgres_connection_state`        | Connections by state (active, idle, idle-in-transaction). |
| `planetscale_edge_postgres_active_connections` | Active connections at the edge.                           |
| `planetscale_postgres_wal_size_bytes`          | WAL size — replication and disk-pressure early warning.   |
| `planetscale_pgbouncer_current_connections`    | PgBouncer pool utilization.                               |
| `planetscale_pods_cpu_util_percentages`        | CPU per pod backing the branch.                           |
| `planetscale_vtgate_total_pods`                | (Vitess) vtgate pods per availability zone.               |

Build dashboards or alert rules grouped by `planetscale_database_branch_id` — e.g. alert when WAL size grows past a threshold or active connections approach your pool limit.

## Health and troubleshooting

- The target's check history shows per-branch scrape outcomes (each branch is a separate `instance`); a branch-level failure is prefixed `[branch:…]` in the target's error display.
- If discovery itself fails transiently, Maple keeps scraping the last-known branch list and surfaces the discovery error on the target — branch metrics don't blink out because of a control-plane hiccup.
- **401/403 on Test** — regenerate the service token and confirm `read_metrics_endpoints` is granted for the organization.
- Changing the organization or rotating the token takes effect on the next scrape — the cached branch list is invalidated on save.
