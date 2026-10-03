---
title: "Alerts rebuilt on one evaluation engine"
description: "Rule previews now come from the evaluator that runs the rule, failed evaluations show up on the rule, and email is a destination."
date: 2026-07-31
category: alerts
authors: [makisuo]
cover: "/changelog/2026-07-alerts.webp"
coverAlt: "Alerts rebuilt: one engine, and a preview chart produced by the evaluator that runs the rule."
breaking: true
---

Every alert rule (built-in signal, query builder or raw SQL) now runs on one evaluation engine. The preview chart you see while building a rule comes from that same engine,
with the same windows, filters and reducers, so it matches what the rule does once saved. Raw SQL
rules get a preview too: use the `$__timeGroup(column)` macro to return one row per window.

- **Failures are visible.** A failed evaluation is recorded as an error check on the rule instead
  of a silent gap. The rule page's **Why is this alert failing?** panel walks each stage, from
  query and data to threshold, incident and delivery, and shows where it broke.
- **Overview first.** **Alerts** opens on firing, needs-attention, healthy and disabled rules,
  each with a 24-hour strip of checks and its last value.
- **Email destinations.** Send alerts to members of your organization without setting up a
  webhook.
- **Fewer false alarms.** Anomaly detection raises fewer false traffic-outage alerts.

### Breaking changes

Existing rules were migrated when this shipped:

- Rules on the legacy `metric` signal type were removed. Recreate them as query-builder rules on
  metrics.
- Slack incoming-webhook and Hazel destinations were removed. Slack alerts now go through the
  [Slack app](/docs/integrations/slack).
- Rules left without a destination were disabled. Attach one and re-enable them.

See [alert rules](/docs/alerting/alert-rules) for the full setup.
