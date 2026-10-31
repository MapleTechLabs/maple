---
title: "How alert rules are evaluated"
description: "How Maple checks an alert rule: windows and check intervals, skipped checks, no data, minimum samples, and the query time limits for SQL rules."
group: "Alerting"
order: 1.5
navLabel: "Rule evaluation"
---

This page covers what happens on each check of an [alert rule](/docs/alerting/alert-rules). You do not need it to create a rule. Read it when a rule fires when you did not expect it to, or never fires.

## Windows and checks

Maple checks every enabled rule on its check interval. Each check aggregates the last **Window** minutes, so a 5-minute window checked every minute is a rolling 5 minutes re-scored every 60 seconds.

Each check is **breached**, **healthy** or **skipped**:

- An incident opens after **Breaches to fire** breached checks, in a row or, with **Out of the last** set, within the last N checks.
- It resolves after **Resolve after** healthy checks in a row.
- A skipped check counts neither as a breach nor as healthy. It leaves the breach and healthy counters where they were.

## Skipped checks and no data

A check is skipped when its window has no data, or fewer samples than **Minimum samples**. A window with no data is treated like this:

| Rule                                                    | A window with no data |
| ------------------------------------------------------- | --------------------- |
| **Alert when there is no data** on (`alert_on_no_data`) | Counts as a breach.   |
| **Throughput** with is below or is at or below          | Counts as zero.       |
| Any other rule                                          | Is skipped.           |

Turn **Alert when there is no data** on for **SQL** rules, where a query that stops matching otherwise goes quiet instead of firing. It is not available on split rules: a group that stops reporting keeps its open incident until its telemetry returns. On an **SQL** rule that returns a `group` column, it fires only when the query returns no rows at all.

## Minimum samples

The **Minimum samples** check runs before the threshold comparison, and a window counted as zero still has zero samples. For **Throughput** the sample count is the signal, so a drop rule with the editor's default of 50 skips every window below 50 requests, including a full outage, and cannot fire for those windows. Set **Minimum samples** to 0 for throughput drop rules, as the **Throughput drop** template does. Then traffic stopping entirely fires the rule.

Short windows on low-traffic services are noisy, because a few slow or failed requests move the value a long way. Raise **Minimum samples** or widen the window for those services.

The editor's chart counts the windows the rule would skip, and why, under the chart.

## Check interval

**Check every** (`evaluation_interval_minutes` in the API) sets how often a rule is checked: every 1, 5, 10, 15, 30 or 60 minutes. Leave it on **Auto** and Maple derives it from the window: a fifth of the window, between 1 and 5 minutes. The window must be at least as long as the interval, so no data falls between two checks.

## Query time limits

An **SQL** rule's query gets more time when the rule is checked less often:

| Check interval     | Query time limit |
| ------------------ | ---------------- |
| Under 5 minutes    | 5 seconds        |
| 5 minutes          | 15 seconds       |
| 10 minutes or more | 25 seconds       |

The editor times one check of an **SQL** rule as you write it and shows **Query time** against the limit of the picked interval. Each option under **Check every** shows its limit. When the query is too slow for that interval, the editor blocks saving until you pick a longer interval or make the query cheaper. When the query is close to its limit, it suggests cheaper filters, such as a service filter. The same timing comes back as `query_timing` from `POST /v2/alerts/rules/preview` and in the `preview_alert_rule` MCP tool.

When a rule's query hits its time or memory limit 3 checks in a row, Maple slows the rule down to the next interval that raises that limit, never past the window. The rule shows when it was slowed down and which interval it runs at. Saving the rule resets the slowdown, so make the query cheaper or pick a longer interval first.

## Next steps

- [Alert rules](/docs/alerting/alert-rules): create a rule.
- [Incidents](/docs/alerting/incidents): what happens after a rule fires.
- [SQL reference](/docs/reference/sql): the macros an SQL rule uses.
