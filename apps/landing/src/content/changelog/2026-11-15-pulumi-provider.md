---
title: "A Pulumi provider for Maple"
description: "Manage dashboards, alert rules, destinations, uptime monitors, scrape targets and API keys from Pulumi programs in TypeScript or Go."
date: 2026-11-15
category: api
authors: [makisuo]
---

Maple configuration can now live in a **Pulumi** program. Install `@maple-dev/pulumi` for
TypeScript, or `github.com/MapleTechLabs/pulumi-maple/sdk` for Go:

- `maple.Dashboard`
- `maple.AlertRule` and `maple.AlertDestination`
- `maple.UptimeMonitor`
- `maple.ScrapeTarget`
- `maple.ApiKey`, plus a `getIngestKeys` function

It is the [Terraform provider](/docs/iac/terraform) packaged for Pulumi, so the resources and
their fields match, in `camelCase`. Credentials and API key secrets are Pulumi secrets, and
existing resources can be brought in with `pulumi import`.

Get started with the [Pulumi guide](/docs/iac/pulumi).
