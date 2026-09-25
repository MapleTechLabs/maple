---
title: "Limits"
description: "Every limit in one place: ingest request size and concurrency, query time ranges, raw SQL, alert rules, event fields, and API and MCP rate limits."
group: "Reference"
order: 10
---

The limits Maple enforces, grouped by where you would hit them. Each links to the page that explains the behavior in full.

## Ingest

See [Ingest API](/docs/reference/ingest) for status codes and retry guidance.

| Limit               | Value                                    | Over the limit               |
| ------------------- | ---------------------------------------- | ---------------------------- |
| Request body        | 20 MiB, measured compressed              | `413`                        |
| Request duration    | 30 seconds                               | `503`, retry after 5 s       |
| Concurrent requests | 1,000 in flight per organization         | `429`, retry after 1 s       |
| Compression         | gzip only                                | `415`                        |
| Session replay      | 1 GiB of uncompressed data per recording | Recording stops at the limit |

## Product events and session events

See [Product events API](/docs/product-events/api). An event that breaks a **dropped** rule is discarded silently; the rest of the batch is still stored. Other fields are truncated to their limit.

| Field                                | Limit                                      | Over the limit |
| ------------------------------------ | ------------------------------------------ | -------------- |
| Event name                           | 128 bytes; no `$` prefix except `$screen`  | Dropped        |
| Event timestamp                      | 30 days in the past to 1 day in the future | Dropped        |
| User, visitor, session and group IDs | 256 bytes                                  | Truncated      |
| Page path                            | 1 KiB                                      | Truncated      |
| URL                                  | 2 KiB                                      | Truncated      |
| Session event message                | 1 KiB                                      | Truncated      |
| Session event attributes             | 32 per event; keys 64 bytes, values 1 KiB  | Truncated      |

## Queries

The dashboard, the API and the MCP tools share these limits. Queries time out after **30 seconds**.

| Query                                   | Longest time range |
| --------------------------------------- | ------------------ |
| Charts and time series                  | 31 days            |
| Trace and log lists                     | 7 days             |
| Breakdowns (top-N by service, route, …) | 30 days            |
| Breakdowns with no filter               | 24 hours           |
| Attribute and metric discovery          | 30 days            |
| Log pattern mining                      | 24 hours           |

A time series returns at most **1,500 points**. Bucket width is chosen from the range, from 1 minute up to 1 day.

## Raw SQL

See [SQL reference](/docs/reference/sql).

| Limit          | Value                                      |
| -------------- | ------------------------------------------ |
| Query text     | 32,768 characters                          |
| Rows returned  | 1,000 (more is an error)                   |
| Result size    | 5 MB of JSON; 64,000 characters per cell   |
| Execution time | 10 seconds; 5 seconds inside an alert rule |

## Alert rules

| Limit                     | Value                                           |
| ------------------------- | ----------------------------------------------- |
| Evaluation window         | 1 minute to 24 hours                            |
| Check interval            | Every minute                                    |
| Groups per raw-SQL alert  | 100                                             |
| Tags per rule             | 20, up to 32 characters each                    |
| Notification template     | 4,000 characters for the title and for the body |
| Webhook response time     | 15 seconds                                      |
| Webhook delivery attempts | 5                                               |

## API and MCP rate limits

| Surface                          | Limit                               | Over the limit                      |
| -------------------------------- | ----------------------------------- | ----------------------------------- |
| [Maple API](/docs/reference/api) (`/v2`)   | 600 requests per 60 seconds per key | `429`, `Retry-After: 60`            |
| [MCP server](/docs/reference/mcp) requests | 120 per 10 seconds per key or user  | `429`, `Retry-After: 10`            |
| API list pages                   | `limit` 1 to 100, default 20        | `400`                               |

Rate limits are counted per edge location, so treat them as approximate rather than an exact global budget.
