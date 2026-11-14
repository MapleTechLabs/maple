---
title: "A Terraform provider for Maple"
description: "Manage dashboards, alert rules, destinations, uptime monitors, scrape targets and API keys in Terraform."
date: 2026-10-28
category: api
authors: [makisuo]
---

Maple now has a **Terraform provider**, `mapletechlabs/maple`. Declare your Maple configuration
next to the infrastructure it watches, and review every change in a plan first:

- `maple_dashboard`
- `maple_alert_rule` and `maple_alert_destination`
- `maple_uptime_monitor`
- `maple_scrape_target`
- `maple_api_key`, plus a `maple_ingest_keys` data source

Existing resources can be imported, so you can bring what you built in the dashboard under Terraform
without recreating it. The provider uses the public v2 API with an API key from
**Settings → Keys**.

Get started with the [Terraform guide](/docs/iac/terraform) and the
[resource reference](/docs/iac/terraform-resources).
