---
title: "Group metrics by several labels at once"
description: "The metrics builder now aggregates within each series and then across series, grouped by up to five fields."
date: 2026-11-06
category: dashboards
authors: [makisuo]
---

The metrics query builder now aggregates in two steps, the way metrics are usually read:

1. **Within each time series**: `avg`, `sum`, `min`, `max`, `count`, `latest`, `rate` or
   `increase` over each interval.
2. **Across time series**: `sum`, `avg`, `min`, `max` or `count`, grouped by up to five fields
   at once, mixing `service.name`, metric attributes and resource attributes.

So "memory summed over pods, by namespace and job" or "requests per second by namespace and host"
is now one builder query instead of SQL.

This also fixes grouped metric charts:

- Series that report more often no longer weigh more in an average.
- A grouped line no longer jumps between services' values from one bucket to the next.
- A `rate` in a widget no longer comes out 60 times too low on a one-minute bucket.
- Pie, table and bar breakdowns now agree with the line chart they came from.
