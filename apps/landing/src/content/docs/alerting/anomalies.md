---
title: "Anomalies"
description: "Maple watches every service for error-rate, latency, traffic and error-log anomalies against its own weekly baseline, with no rules to write. How detection works, when an anomaly opens and resolves, and how to tune or mute it."
group: "Alerting"
order: 6
---

Maple compares every service against its own recent history and opens an anomaly when a signal moves well outside it. There are no rules to write and nothing to install: detection starts on every service that sends traces or logs, once it has a few days of history.

Anomalies are for the problems you did not write an alert for. For a threshold you know you care about, use an [alert rule](/docs/alerting/alert-rules).

## What is watched

| Signal           | Per                     | Opens when                                                                              |
| ---------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| **Error rate**   | service and environment | The share of failed requests is well above its baseline and at least 2 points higher.   |
| **p95 latency**  | service and environment | p95 latency is well above its baseline and at least 50 ms slower.                       |
| **Traffic loss** | service and environment | A service with steady traffic drops below 5% of its usual request rate.                 |
| **Error logs**   | service and environment | The rate of error-level logs is well above its baseline.                                |
| **Error spike**  | error fingerprint       | One error type occurs far more often in 30 minutes than it does in a typical half hour. |

Traffic loss only fires on near-total loss of a stream that is normally busy. A slow day does not open an anomaly. An error spike only applies to errors Maple has seen for more than a day; a brand-new error opens an [issue](/docs/errors/overview) instead.

## How detection works

Maple checks every 5 minutes. For the current hour of the day, it builds a baseline from the same hour, and the hours on either side of it, over the last 7 days. A Monday 14:00 is compared with 13:00 to 15:00 on the previous days, so daily traffic patterns are not anomalies.

The baseline is the median of those hours, and the spread around it is measured robustly, so one bad hour last week does not move it. A signal breaches when it is far outside that spread **and** a set multiple above the median **and** past a minimum absolute change. All three must hold, which keeps quiet services from paging on noise.

A series is skipped until it has enough data:

- At least 6 hours of baseline history at matching hours.
- At least 50 requests in the current hour for error rate and latency.
- At least 10 minutes into the current hour for traffic and error logs.
- At least 10 occurrences in 30 minutes for an error spike.

On busy organizations Maple evaluates the 200 busiest services.

## Open, resolve, reopen

An anomaly opens after 2 breaching checks in a row (10 minutes). Traffic loss needs 3 (15 minutes).

It resolves after 3 healthy checks in a row, or 1 for traffic loss once requests come back. An anomaly with no data for an hour resolves on its own. You can also resolve one by hand.

An anomaly that breaches again within 6 hours of resolving reopens the same anomaly rather than opening a new one, and its reopen count goes up. Error spikes on one service and environment are grouped into one anomaly with every fingerprint listed.

### Severity

Every anomaly is a **warning** unless it is far out:

- **Error rate** is **critical** at 3 times its baseline or 10 points above it.
- **p95 latency** is **critical** at 4 times its baseline.
- **Error spike** is **critical** at 3 times the spike threshold.

Traffic loss and error logs are always warnings.

## Where anomalies show up

- **Anomalies** in the sidebar lists every anomaly, filterable by service, environment, signal and severity.
- Each anomaly has a page with the observed signal charted against its baseline, and the values at open, now, baseline, threshold and deviation.
- On [Services](/docs/explore/services), a service with an open anomaly shows as degraded, or unhealthy when the anomaly is critical.
- **Open investigation** on an anomaly hands it to the AI agent. With AI triage turned on under **Settings → AI**, an agent investigates each new anomaly by itself and attaches a triage summary.
- **Link issue** ties an anomaly to the [error issue](/docs/errors/overview) behind it. Error spikes are linked to their issue automatically.

## Tuning

Detection is on for every organization with **normal** sensitivity. An organization admin can change it over the [API](/docs/reference/api) with `PATCH /v2/anomalies/settings`:

| Field          | Values                                                                 | What it does                                                                                                                        |
| -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`      | `true`, `false`                                                        | Turns detection on or off for the whole organization.                                                                               |
| `sensitivity`  | `low`, `normal`, `high`                                                | How far from baseline a signal must move. `low` needs about 1.5 times the deviation of `normal`, `high` about three quarters of it. |
| `mutedSignals` | `error_rate`, `latency_p95`, `throughput`, `error_spike`, `log_volume` | Signals that never open an anomaly.                                                                                                 |

```bash
curl -X PATCH https://api.maple.dev/v2/anomalies/settings \
  -H "Authorization: Bearer $MAPLE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sensitivity": "low", "mutedSignals": ["log_volume"]}'
```

Every change is recorded in the organization's audit log.
