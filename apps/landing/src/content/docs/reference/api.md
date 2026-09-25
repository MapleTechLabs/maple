---
title: "Maple API"
description: "The Maple REST API: base URLs, API keys and scopes, the resources it exposes, pagination, the error envelope, rate limits, and where the OpenAPI specification lives."
group: "Reference"
order: 1
navLabel: "REST API"
---

The Maple API is the HTTP interface to your Maple organization. It covers dashboards, alert rules and destinations, error issues, scrape targets, ingest and API keys, and read access to traces, logs, metrics, services and session replays. The dashboard uses the same endpoints.

|                           |                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Base URL (US)             | `https://api.maple.dev/v2`                                                                                      |
| Base URL (EU)             | `https://api.eu.maple.dev/v2`                                                                                   |
| Interactive reference     | [api.maple.dev/v2/docs](https://api.maple.dev/v2/docs) (EU: [api.eu.maple.dev/v2/docs](https://api.eu.maple.dev/v2/docs)) |
| OpenAPI 3.1 specification | [maple.dev/openapi.json](/openapi.json) (also [api.maple.dev/openapi.json](https://api.maple.dev/openapi.json)) |
| MCP server for AI agents  | [Maple MCP server](/docs/reference/mcp)                                                                         |
| Auth                      | `Authorization: Bearer maple_ak_…`                                                                              |

Use the base URL of your organization's [region](/docs/reference/regions). A key created in one region does not work in the other.

## Authentication

Create an API key in the dashboard under **Settings → API Keys**, or with `POST /v2/api_keys` using an existing key. Send it as a Bearer token on every request:

```bash
curl https://api.maple.dev/v2/services \
  -H "Authorization: Bearer maple_ak_…"
```

Keys can be **scoped** at creation. A scope is `<family>:read`, `<family>:write`, or `*`. The family is the first path segment under `/v2`, listed in the resource index below. `write` implies `read`, and a key with no scopes has full access. `GET` requests need `read`; `POST`, `PATCH`, `PUT` and `DELETE` need `write`, except the search, timeseries, breakdown and preview `POST`s, which need only `read`. A request outside a key's scopes fails with `403`, `type: "permission_error"` and `code: "insufficient_scope"`.

Keys belong to one organization. [Authentication](/docs/reference/authentication) covers every credential Maple accepts, including dashboard session tokens and the `x-maple-org-id` header.

## Resources

Each row is one scope family. The [interactive reference](https://api.maple.dev/v2/docs) documents every operation.

| Family | Endpoints |
| --- | --- |
| `api_keys` | List, create, get, revoke and roll API keys |
| `ingest_keys` | Read the organization's public and private ingest keys, and roll either one |
| `organization` | The current organization |
| `audit_log` | The organization's audit log |
| `dashboards` | Dashboards, templates, version history and restore, public share links, Perses import |
| `alerts` | Alert rules (with test and preview), rule checks, destinations, incidents and deliveries |
| `error_issues` | Error issues and per-service issue counts |
| `traces` | Search traces, time series and breakdowns, one trace, one span |
| `logs` | Search logs, time series and breakdowns, one log record |
| `metrics` | List metrics, time series and breakdowns |
| `services` | Services, one service, and a service overview |
| `service_map` | Service dependency edges |
| `environments` | Deployment environments seen in your data |
| `session_replays` | Search replays, the replays for a trace, one replay's manifest, events and transcript |
| `scrape_targets` | Prometheus scrape targets, their checks, and a test probe |
| `attribute_mappings` | Attribute mappings |
| `instrumentation` | Instrumentation recommendations, the setup audit, and which signals each service sends |
| `integrations` | Chat connectors and the PlanetScale integration |

## Conventions

- Resources are plural nouns under `/v2` (`/v2/api_keys`, `/v2/alerts/rules`). Actions that are not plain CRUD are `POST`s to a sub-resource (`POST /v2/api_keys/{id}/roll`). Complex reads are `POST …/search`.
- Every object carries an `object` field and a prefixed, opaque public ID (`key_…`, `dash_…`, `alrt_…`).
- The wire format is snake_case JSON with ISO-8601 UTC timestamps. Nullable fields are explicit `null`.
- Updates are JSON `PATCH` bodies.

## Pagination

List endpoints accept `limit` (1 to 100, default 20) and an opaque `cursor`. They return:

```json
{ "object": "list", "data": [], "has_more": true, "next_cursor": "…" }
```

To read the next page, send the same request with `cursor` set to `next_cursor`. Stop when `has_more` is `false`. A `limit` outside 1 to 100 is a `400`.

## Errors

Every failure, including an unknown route, returns a JSON envelope with the same shape:

```json
{
	"error": {
		"_tag": "@maple/http/v2/RouteNotFoundError",
		"type": "not_found_error",
		"code": "route_not_found",
		"title": "No such route",
		"message": "No route matches GET /v2/typo. The Maple API is documented at https://api.maple.dev/v2/docs; the OpenAPI specification is at https://api.maple.dev/openapi.json.",
		"retryable": false,
		"recovery": "fix_request"
	}
}
```

| Field | Meaning |
| --- | --- |
| `_tag` | The exact failure. Branch on this. The OpenAPI spec lists the tags each operation can return |
| `type` | The status family: `invalid_request_error` (400), `authentication_error` (401), `payment_error` (402), `permission_error` (403), `not_found_error` (404), `conflict_error` (409), `rate_limit_error` (429) or `api_error` (5xx) |
| `code` | A short category for display |
| `title`, `message` | Human-readable text, safe to show to users |
| `retryable` | `true` when the same request can succeed later. The response then also carries `Retry-After` |
| `recovery` | What the client should do: `none`, `fix_request`, `reauthenticate`, `request_access`, `reconnect`, `refresh`, `retry` or `contact_support` |

Stack traces and upstream error messages are never included.

## Rate limits

API-key requests share **600 requests per 60 seconds per key** across the whole `/v2` surface. Over the budget you get `429` with `type: "rate_limit_error"`, `code: "rate_limited"`, and `Retry-After: 60`. See [Limits](/docs/reference/limits) for the rest.

## OpenAPI specification

Every operation in the [OpenAPI document](/openapi.json) has a unique `operationId`, a `summary` and `description`, typed parameters, request and response schemas, and the error `_tag`s it can return. You can import it into Postman, Insomnia, Scalar or `openapi-generator`, or point an LLM function-calling tool at `https://maple.dev/openapi.json`. The [interactive reference](https://api.maple.dev/v2/docs) renders the same document.

To connect an AI agent without generating a client, use the [MCP server](/docs/reference/mcp).

## Versioning

`/v2` is the major version. Changes within it are additive, and error `_tag` values do not change. The v1 endpoints under `/api/…` remain available for existing integrations but get no new features.
