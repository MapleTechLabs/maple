---
title: "Incidents"
description: "What happens after a Maple alert rule fires: how an incident opens, renotifies, waits on missing data and resolves, what each notification contains, and where to see incidents."
group: "Alerting"
order: 2
---

An **incident** is one period during which an [alert rule](/docs/alerting/alert-rules) is breaching. Maple opens it, notifies the rule's [destinations](/docs/alerting/notification-destinations), repeats the notification while the breach continues, and resolves it when the signal recovers.

A rule that evaluates several groups (several services, or a **Group by**) keeps a separate incident for each group. One slow route opens one incident. It does not open or resolve the others.

## Lifecycle

Maple checks every enabled rule once a minute. Each check is **breached**, **healthy** or **skipped** (too few samples, or no data).

| Step       | When it happens                                                                                                  | Notification |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ------------ |
| Open       | The rule breaches on **Breaches to fire** consecutive checks.                                                     | `trigger`    |
| Renotify   | The incident is still breaching and **Renotify (min)** minutes have passed since the last notification.          | `renotify`   |
| Resolve    | The rule is healthy on **Healthy to resolve** consecutive checks.                                                 | `resolve`    |

Skipped checks do not move the incident either way. The breach and healthy counters keep their values until the next check that has enough data.

An incident has two statuses, **open** and **resolved**. A resolved incident stays resolved. If the rule breaches again later, Maple opens a new incident.

### Flapping

If a rule resolves and then opens a new incident for the same group within its **Renotify (min)** interval, Maple opens the incident without sending a `trigger`. The matching `resolve` is not sent either. This stops a signal that hovers around the threshold from sending a notification every few minutes.

## Waiting on data

A breach can stop appearing because the problem is fixed, or because the service stopped sending telemetry. Before it resolves an incident on an empty window, Maple checks whether the service's traffic is still arriving. It compares the current window with the traffic just before the incident opened, and with the same time the day before.

If Maple cannot confirm the traffic, the incident stays open and shows **Waiting on data** in place of its current value. Hovering the badge shows why:

| Situation                                                                  | Resolves                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| The service stopped reporting.                                             | When telemetry returns, or after 6 hours.                    |
| Traffic fell below half of its usual level.                                | When data returns, or after 3 windows (at least 30 minutes). |
| Raw span counts fell while sample-weighted counts did not (sampling changed). | When the signal settles, or after 6 hours.                |
| Maple could not verify telemetry for the service.                          | On the next successful check.                                |

If the breach reappears while the incident is waiting, it goes back to firing. If the time limit passes without a breach, Maple resolves the incident and says so in the resolve reason.

## What a notification contains

The built-in format carries:

- The rule name and the event (**Triggered**, **Re-notification**, **Resolved** or **Test**).
- The severity (**Warning** or **Critical**).
- The signal, the observed value and the threshold it was compared against.
- The group, or `all` for an ungrouped rule.
- The evaluation window.
- A link to the alert in Maple and a link to ask Maple AI about it.

A rule's **Message template** replaces the title and body for Slack, Discord, Telegram and PagerDuty destinations. Email, webhook and Hazel destinations use the built-in format. PagerDuty receives a stable `dedup_key` so the trigger and resolve land on the same PagerDuty incident. The webhook payload is in the [alert webhooks reference](/docs/reference/webhooks).

If a delivery fails with an error that can be retried, Maple retries it up to 5 attempts, with a delay that doubles from 1 minute up to 15 minutes.

## Where to see incidents

- **Alerts → Overview.** When anything is firing, **Active incidents** lists every open incident with its **Severity**, **Rule**, **Group**, **Current value**, **Duration** and **Last notified** time. The summary cards count rules that are **Firing**, **Needs attention**, **Healthy** and **Disabled**.
- **The rule's page.** Click a rule or an incident row. The **Overview** tab charts the signal with the threshold and lists recent checks. The **History** tab lists past incidents, filterable by **All**, **Fired** and **Resolved**, with **Total triggered**, **Avg resolution** and **Top contributors**.
- **MCP.** `list_alert_incidents` and `get_incident_timeline` on the [MCP server](/docs/reference/mcp) return the same data to an AI assistant.

## Troubleshooting

- **An incident is stuck on Waiting on data.** The service stopped sending the telemetry the rule reads. Check the service under **Traces**. The incident resolves on its own once data returns or the time limit passes.
- **An incident opened but nobody was notified.** Check that the rule has destinations and that none is marked **Disabled** on the **Destinations** tab. A re-opened incident inside the renotify interval is silent by design (see [Flapping](#flapping)).
- **Too many notifications.** Raise **Renotify (min)**, or raise **Breaches to fire** and **Healthy to resolve** on the rule.

## Next steps

- [Alert rules](/docs/alerting/alert-rules): the settings that control when incidents open and resolve.
- [Notification destinations](/docs/alerting/notification-destinations): where notifications go.
- [Alert webhooks reference](/docs/reference/webhooks): the webhook payload.
