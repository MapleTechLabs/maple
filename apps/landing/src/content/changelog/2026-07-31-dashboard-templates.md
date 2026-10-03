---
title: "Dashboard templates sorted by what your data supports"
description: "The templates page now shows which dashboards would fill with data today, and says exactly what's missing for the rest."
date: 2026-07-31
category: dashboards
authors: [makisuo]
---

The templates page used to show every template as a card and dim the ones your org couldn't use,
without saying why. It now splits templates into **Ready for your data** and **Needs setup**, so
you can see at a glance which dashboards would render something today.

Templates under **Needs setup** name what's missing, such as `no k8s.pod.*` for a metric prefix
you aren't sending yet, or `not connected` for an integration. Select any template to open a
preview panel that renders its real widgets against your own data before you create it.

Also in this release:

- Raw SQL widgets and query builder widgets now share the same chart types.
- Better default widget heights, a proper loading screen, and a rebuilt dashboards list.
- Fixed: stacked area charts outlining the whole stack instead of each series.
- Fixed: an "Update failed" banner that could get stuck and leave a dashboard read-only.
- Fixed: two templates (NATS and RabbitMQ) were missing from the templates page.

Get started with [building dashboards](/docs/dashboards/build-dashboards).
