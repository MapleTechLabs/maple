---
title: "The v2 API, an Alchemy provider and browser CLI login"
description: "A documented, stable REST API for your organization, dashboards and alerts as infrastructure-as-code, and browser sign-in for the CLI and MCP."
date: 2026-07-21
category: api
authors: [makisuo]
cover: "/changelog/2026-07-api.webp"
coverAlt: "The Maple v2 API: documented and stable, with an Alchemy provider for declaring Maple resources in code."
---

The **Maple v2 API** is the documented, stable HTTP interface to your organization, and the Maple
dashboard runs on the same endpoints. It uses one set of conventions throughout: prefixed object
IDs (`dash_…`, `key_…`), cursor pagination, a single error envelope, and snake_case fields. It
covers dashboards, alert rules, destinations and incidents, error issues, scrape targets, ingest
and API keys, and read access to traces, logs, metrics and services.

When you create an API key under **Settings → API Keys** you can now scope it (for example
`dashboards:read` or `alerts:write`) and set an expiry. Each key gets 600 requests per 60 seconds.

Also shipping:

- **`@maple-dev/alchemy`**: declare dashboards, alert rules, alert destinations and API keys in your
  `alchemy.run.ts` and deploy them with the infrastructure they monitor.
- **`maple auth login`**: sign the CLI in through your browser. Credentials go to the macOS
  Keychain or Linux Secret Service.
- **MCP over OAuth**: clients that support MCP authorization connect with only the endpoint URL
  and a browser sign-in. Standard API keys also work against MCP, and members can now create MCP
  keys, not only admins.

Get started with the [API reference](/docs/reference/api), or browse every operation at
[api.maple.dev/v2/docs](https://api.maple.dev/v2/docs).
