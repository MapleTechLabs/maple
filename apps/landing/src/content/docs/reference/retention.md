---
title: "Retention"
description: "How long hosted Maple keeps each kind of data: traces, logs, metrics, session replays, product events, error issues, alert history and the audit log."
group: "Reference"
order: 10
---

Hosted Maple deletes data automatically once it passes its retention period. The periods work the same in both [regions](/docs/reference/regions). Age is measured from the data's own timestamp (for example a span's start time), except session replay recordings, which age from when Maple received them.

## Set your own periods

Traces, logs, metrics, session replays, product events and profiles each have a period you can change in **Settings → Retention**: 3, 7, 14, 30, 60, 90 or 180 days, 1 year or 2 years. A source can keep a signal for a period of its own, shorter or longer than the organization's, from its **Settings** tab. Changing a period needs the **Manage retention** permission.

Data is stored under the period in force when it arrived:

- **A shorter period** hides older data right away. It is deleted when the period it was stored under ends, so switching back before then brings it back.
- **A longer period** applies to data received from then on. The full history fills in over time; data already stored keeps its earlier period.
- **Reads** reach as far back as the longest period any of your sources keeps.

The same settings are in the API: `GET /v2/retention`, `PATCH /v2/retention` and `PATCH /v2/retention/sources/{id}`. An organization that stores telemetry in its own ClickHouse keeps the retention set in that cluster instead.

## Telemetry

When nothing is set, each signal keeps its default:

| Data                                                                                              | Kept for |
| ------------------------------------------------------------------------------------------------- | -------- |
| Traces (spans)                                                                                    | 30 days  |
| Logs                                                                                              | 30 days  |
| Metrics (sum, gauge, histogram, exponential histogram)                                            | 90 days  |
| Session replays (recordings and their timeline events)                                            | 30 days  |
| Product events                                                                                    | 365 days |
| Error occurrences (the individual events behind error issues)                                     | 90 days  |
| Hourly rollups of traces and logs (service overview, service map edges, trace and log aggregates) | 365 days |
| CI workflow runs and jobs (Code Review → CI)                                                      | 365 days |

Individual spans, log lines and data points cannot be read once they pass these periods. Charts built on hourly rollups, such as service overviews and the service map, can reach further back, up to the rollup's 365 days. Some queries have shorter maximum time ranges. See [Limits](/docs/reference/limits#queries).

## Error issues

[Error issues](/docs/errors/overview) are not deleted by age while they are open, no matter how old their errors are. These rules clean them up:

| Issue state                                                                              | What happens                                                         |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Resolved (`done`) for 14 days                                                            | The issue is archived                                                |
| Grouped under an older fingerprinting scheme, after Maple changes how errors are grouped | The issue is archived, and new occurrences open a new issue          |
| Archived for 90 days                                                                     | The issue is deleted, with its incidents, comments and state history |
| A fingerprint that never became an issue                                                 | Forgotten after 24 hours without a new occurrence                    |

## Alerts and audit history

| Data                                                         | Kept for             |
| ------------------------------------------------------------ | -------------------- |
| Alert rule checks (each evaluation, with its observed value) | 365 days             |
| Organization audit log (**Settings → Audit log**)            | 6 years (2,190 days) |

## Maple Local

Maple Local keeps logs and traces for 30 days and metrics for 90, and lets you raise the floor for raw data. See [Your data](/docs/local-mode#your-data). To keep history longer, export it with [archives](/docs/local-mode/checkpoints-and-archives#archives).
