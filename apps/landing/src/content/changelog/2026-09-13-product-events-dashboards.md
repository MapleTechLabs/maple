---
title: "Product events on dashboards, with funnel drop-off and paths"
description: "Chart, break down, list and alert on product events like any other signal, and see where people leave a funnel and what they do next."
date: 2026-09-13
category: dashboards
authors: [makisuo]
---

Product events are now a full dashboard source, next to traces, logs and metrics. Before this, a
funnel was the only widget that could read them.

In any query panel, pick **Product events** as the source. You can chart an event count as a line
or a stat, break events down by event name, page or property, count distinct people or sessions,
list recent events, and use event counts in formulas. The Add widget picker has presets for Top
Events, Events by Page and Recent Events. Alert rules accept product event counts too.

### Funnel drop-off

In a funnel widget's settings, set **View** to **Drop-off**. Each step shows who reached it and
who left since the previous step, with the step's conversion and the median time between steps.
Hover a step for p50 and p90 timing and the events the people who left went to next.

### Paths

The new **Paths** widget shows what people do in the steps after an event or page, or before it.
Choose the anchor, the direction, up to five steps and how many branches to name per step.

Get started with [Product events](/docs/product-events/overview).
