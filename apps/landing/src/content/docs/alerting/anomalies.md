---
title: "Anomalies"
description: "Maple watches every service for error-rate, latency, traffic and error-log anomalies against its own weekly baseline, with no rules to write. How detection works, when an anomaly opens and resolves, and how to tune or mute it."
group: "Alerting"
order: 6
---

Maple compares every service against its own recent history and opens an anomaly when a signal moves well outside it. There are no rules to write and nothing to install: detection starts on every production service that sends traces or logs, once it has a few days of history.

Anomalies are for the problems you did not write an alert for. For a threshold you know you care about, use an [alert rule](/docs/alerting/alert-rules).

## What is watched

| Signal           | Per                     | Opens when                                                                                                 |
| ---------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Error rate**   | service and environment | The share of failed requests is well above its baseline, at least 2 points higher, with at least 5 errors. |
| **p95 latency**  | service and environment | p95 latency is well above its baseline and at least 100 ms slower.                                         |
| **Traffic loss** | service and environment | A service with steady traffic drops below 5% of its usual request rate.                                    |
| **Error logs**   | service and environment | The rate of error-level logs is well above its baseline.                                                   |
| **Error spike**  | error fingerprint       | One error type occurs far more often in 30 minutes than it does in a typical half hour.                    |

Traffic loss only fires on near-total loss of a stream that is normally busy, at least one request a minute. A slow day does not open an anomaly.

An error spike only applies to errors Maple has seen for more than a day. A brand-new error opens an [issue](/docs/errors/overview) instead.

### Environments

Maple watches production by default. It skips environments whose `deployment.environment` reads as non-production, such as `staging`, `development`, `dev-eu`, `local`, `qa`, `preview` or `pr-123`. An empty or unrecognized environment counts as production. To watch one of the skipped environments, list it in `included_environments` (see [Tuning](#tuning)).

## How detection works

Maple checks every 5 minutes and always looks at the last 60 minutes. It compares those 60 minutes with the same 60 minutes on each of the previous 7 days, and with that window an hour earlier and an hour later. At 14:20 on a Monday, the window 13:20 to 14:20 is compared with 12:20 to 15:20 on the previous days, so daily traffic patterns are not anomalies.

The baseline is the median of those windows. The spread around the median is measured robustly, so one bad hour last week does not move the baseline. A signal breaches when all three of these hold:

- It is far outside that spread.
- It is a set multiple above the median.
- It is past a minimum absolute change.

Requiring all three keeps quiet services from paging on noise.

Maple also checks the same window on its own. When a service is slow or failing at this time on most previous days, for example during a nightly job, that behavior is normal for the service and does not open an anomaly.

A series is skipped until it has enough data:

- At least 6 baseline windows with traffic.
- At least 50 requests in the last 60 minutes for error rate and latency.
- At least 30 error logs in the last 60 minutes for error logs.
- At least 20 occurrences in 30 minutes for an error spike.

On busy organizations Maple evaluates the 200 busiest services.

## Open, resolve, reopen

An anomaly opens after 2 breaching checks in a row (10 minutes). Traffic loss needs 3 (15 minutes).

An anomaly resolves after 3 healthy checks in a row, or 1 for traffic loss once requests come back. An anomaly with no breach for an hour resolves on its own. You can also resolve one by hand.

An anomaly that breaches again within 6 hours of resolving reopens instead of opening a new anomaly, and its reopen count goes up. Each reopen makes the anomaly wait longer before it resolves again, up to 3 times as long. A flapping signal then stays one open anomaly instead of resolving and reopening every hour.

Error spikes on one service and environment are grouped into one anomaly with every fingerprint listed.

### Severity

Every anomaly is a **warning** unless it is far out:

- **Error rate** is **critical** at 3 times its baseline or 10 points above it.
- **p95 latency** is **critical** at 4 times its baseline and at least 500 ms slower.
- **Error spike** is **critical** at 3 times the spike threshold.

Traffic loss and error logs are always warnings.

## Where anomalies show up

- **Alerts → Inbox** lists anomalies when you turn on the **Anomalies** filter, with a choice of **Open**, **Resolved** or **All**.
- Each anomaly has a page with the observed signal charted against its baseline, and the values at open, now, baseline, threshold and deviation.
- On [Services](/docs/explore/services), a service with an open anomaly shows as degraded, or unhealthy when the anomaly is critical.
- **Open investigation** on an anomaly hands it to the AI agent. With AI triage turned on under **Settings → AI**, an agent investigates each new anomaly by itself and attaches a triage summary.
- **Link issue** ties an anomaly to the [error issue](/docs/errors/overview) behind it. Error spikes are linked to their issue automatically.

## Tuning

Detection is on for every organization with **normal** sensitivity. An organization admin can change it over the [API](/docs/reference/api) with `PATCH /v2/anomalies/settings`:

| Field                   | Values                                                                 | What it does                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`               | `true`, `false`                                                        | Turns detection on or off for the whole organization.                                                                               |
| `sensitivity`           | `low`, `normal`, `high`                                                | How far from baseline a signal must move. `low` needs about 1.5 times the deviation of `normal`, `high` about three quarters of it. |
| `muted_signals`         | `error_rate`, `latency_p95`, `throughput`, `error_spike`, `log_volume` | Signals that never open an anomaly.                                                                                                 |
| `included_environments` | environment names, such as `["staging"]`                               | Non-production environments to watch anyway. Up to 50.                                                                              |

```bash
curl -X PATCH https://api.maple.dev/v2/anomalies/settings \
  -H "Authorization: Bearer $MAPLE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sensitivity": "low", "muted_signals": ["log_volume"], "included_environments": ["staging"]}'
```

Every change is recorded in the organization's audit log.
