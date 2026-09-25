---
title: "Retention"
description: "How long hosted Maple keeps each kind of data: traces, logs, metrics, session replays, product events, error issues, alert history and the audit log."
group: "Reference"
order: 9
---

Hosted Maple deletes data automatically once it passes its retention period. The periods are the same in both [regions](/docs/reference/regions). Age is measured from the data's own timestamp (for example a span's start time), not from when Maple received it.

## Telemetry

| Data | Kept for |
| --- | --- |
| Traces (spans) | 30 days |
| Logs | 30 days |
| Metrics (sum, gauge, histogram, exponential histogram) | 90 days |
| Session replays (recordings and their timeline events) | 30 days |
| Product events | 365 days |
| Error occurrences (the individual events behind error issues) | 90 days |

Pages and queries cannot reach data older than these periods, and some queries have shorter maximum time ranges. See [Limits](/docs/reference/limits#queries).

## Error issues

[Error issues](/docs/errors/overview) are not deleted by age while they are open, however old the underlying errors are. These rules clean them up:

| Issue state | What happens |
| --- | --- |
| Resolved (`done`) for 14 days | The issue is archived |
| Grouped under an older fingerprinting scheme, after Maple changes how errors are grouped | The issue is archived, and new occurrences open a new issue |
| Archived for 90 days | The issue is deleted, with its incidents, comments and state history |
| A fingerprint that never became an issue | Forgotten after 24 hours without a new occurrence |

## Alerts and audit history

| Data | Kept for |
| --- | --- |
| Alert rule checks (each evaluation, with its observed value) | 365 days |
| Organization audit log (**Settings → Audit Log**) | 6 years (2,190 days) |

## Maple Local

Maple Local keeps logs and traces for 30 days and metrics for 90, and lets you raise the floor for raw data. See [Your data](/docs/local-mode#your-data). To keep history longer, export it with [archives](/docs/local-mode/checkpoints-and-archives#archives).
