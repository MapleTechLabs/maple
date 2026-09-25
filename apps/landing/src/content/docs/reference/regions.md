---
title: "Regions"
description: "Maple runs in a US region and an EU region. The hosts for the app, ingest, API and MCP server in each, how to find your organization's region, and how to point SDKs and tools at it."
group: "Reference"
order: 5
---

Maple runs as two separate instances: one in the United States and one in the European Union (Frankfurt). Each has its own dashboard, ingest endpoint, API, database and storage. An organization's telemetry is stored and processed only in its region. Nothing is copied between them.

## Hosts

| | United States | European Union (Frankfurt) |
| --- | --- | --- |
| Dashboard | `https://app.maple.dev` | `https://app.eu.maple.dev` |
| Ingest (OTLP) | `https://ingest.maple.dev` | `https://ingest.eu.maple.dev` |
| REST API | `https://api.maple.dev/v2` | `https://api.eu.maple.dev/v2` |
| MCP server | `https://api.maple.dev/mcp` | `https://api.eu.maple.dev/mcp` |
| API docs | `https://api.maple.dev/v2/docs` | `https://api.eu.maple.dev/v2/docs` |

Examples on this site use the US hosts. For an EU organization, replace `maple.dev` with `eu.maple.dev` in the host and change nothing else.

Keys do not cross regions. An ingest key or API key created in one region is rejected by the other, so a mismatch shows up as `401` rather than as data landing in the wrong place.

## Find your organization's region

- **Settings → Organization** shows a **Data region** row: "United States" or "European Union (Frankfurt)".
- The organization switcher in the sidebar shows `· US` or `· EU` after the organization name.
- The dashboard host you use is the region: `app.maple.dev` is US, `app.eu.maple.dev` is EU.

## Choosing a region

A new organization chooses its region in the first onboarding step. The region cannot be changed later. Organizations created before regions existed are in the US region.

What the EU region covers is described on [EU hosting](/eu).

## Point your tools at a region

| Tool | US (default) | EU |
| --- | --- | --- |
| Any OpenTelemetry SDK or Collector | `OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev` | `OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.eu.maple.dev` |
| [`@maple-dev/effect-sdk`](/docs/sdks/effect) (server and Cloudflare) | nothing to set | `MAPLE_REGION=eu`, or `region: "eu"` in the layer config |
| [`@maple-dev/effect-sdk`](/docs/sdks/effect-client) (browser) | nothing to set | `region: "eu"` |
| [`@maple-dev/browser`](/docs/session-replay/browser-sdk) | nothing to set | `region: "eu"` |
| [`maple` CLI](/docs/reference/cli#using-the-cli-with-hosted-maple) | `maple auth login` | `maple auth login --api-url https://api.eu.maple.dev` |
| [MCP clients](/docs/reference/mcp) | `https://api.maple.dev/mcp` | `https://api.eu.maple.dev/mcp` |

In the Maple SDKs an explicit endpoint always wins over `region`. For `@maple-dev/effect-sdk` on a server that means `MAPLE_ENDPOINT`, then `OTEL_EXPORTER_OTLP_ENDPOINT`, then `MAPLE_REGION`. An unrecognized region value logs a warning and falls back to US.

## Related

- [Authentication](/docs/reference/authentication): which key goes where
- [Ingest API](/docs/reference/ingest): paths, limits and status codes
- [Retention](/docs/reference/retention): how long each region keeps your data
