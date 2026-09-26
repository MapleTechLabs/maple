---
title: "Maple MCP server"
description: "Connect Claude, Cursor and other AI agents to your Maple telemetry over the Model Context Protocol: endpoints, authentication, and every tool the server exposes."
group: "Reference"
order: 2
navLabel: "MCP server"
---

Maple runs a hosted **Model Context Protocol (MCP)** server. An AI agent connected to it can list services, search traces and logs, triage error issues, read and edit dashboards, and manage alert rules in your organization.

|                          |                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Endpoint (US)            | `https://api.maple.dev/mcp`                                                                                                                |
| Endpoint (EU)            | `https://api.eu.maple.dev/mcp`                                                                                                             |
| Transport                | Streamable HTTP                                                                                                                            |
| Manifest (`server.json`) | [maple.dev/.well-known/mcp.json](/.well-known/mcp.json) · [api.maple.dev/.well-known/mcp.json](https://api.maple.dev/.well-known/mcp.json) |
| Registry name            | `dev.maple/maple`                                                                                                                          |
| Auth                     | Maple API key as Bearer token, or OAuth 2.1                                                                                                |
| Rate limit               | 120 requests per 10 seconds per key or user; over it, `429` with `Retry-After: 10`                                                         |

Use the endpoint of your organization's [region](/docs/reference/regions). The examples below use the US endpoint; for an EU organization replace `api.maple.dev` with `api.eu.maple.dev`.

## Connecting a client

Any MCP client that speaks Streamable HTTP can connect. **Settings → MCP** in the dashboard shows the endpoint for your region and ready-made configuration for common clients. There are two ways to authenticate. Both are described in more detail on [Authentication](/docs/reference/authentication).

**API key.** Create a key under **Settings → MCP** or **Settings → API Keys** and pass it as a Bearer token:

```json
{
	"mcpServers": {
		"maple": {
			"type": "http",
			"url": "https://api.maple.dev/mcp",
			"headers": { "Authorization": "Bearer maple_ak_…" }
		}
	}
}
```

For Claude Code: `claude mcp add --transport http maple https://api.maple.dev/mcp --header "Authorization: Bearer maple_ak_…"`.

**OAuth.** Clients that support the MCP authorization flow need no key. The server publishes its protected-resource metadata at `https://api.maple.dev/.well-known/oauth-protected-resource/mcp` and its authorization server metadata at `https://api.maple.dev/.well-known/oauth-authorization-server`. Dynamic client registration and PKCE (`S256`) are supported, so the client needs only the endpoint URL. It opens a browser sign-in on first use.

Requests are scoped to the organization the key belongs to, or the one chosen at sign-in. A user in several organizations picks one during the OAuth consent step.

## Tools

The server exposes the tools below. Read-only tools are marked **read**; the rest change data in your organization. `tools/list` returns the current set with full parameter schemas.

### Services and discovery

| Tool | Access | What it does |
| --- | --- | --- |
| `list_services` | read | Active services with throughput, error rate and P95 latency |
| `diagnose_service` | read | One service's health metrics, Apdex, top errors, recent traces and logs |
| `get_service_top_operations` | read | A service's top operations (endpoints or spans), ranked by a chosen metric |
| `service_map` | read | Service-to-service dependencies with call counts, error rates and latency per edge |
| `compare_periods` | read | Error rate, throughput and P95 across two periods, overall and per service, with regressions flagged |
| `explore_attributes` | read | Attribute keys and their values for filtering; `source=services` lists environments and commit SHAs |
| `list_metrics` | read | Custom metrics with type, unit, monotonicity and data volume |
| `describe_warehouse_tables` | read | Tables and columns available to raw SQL, with sorting keys and notes on units and casing |

### Traces, logs and queries

| Tool | Access | What it does |
| --- | --- | --- |
| `search_traces` | read | Find traces by service, duration, error status, HTTP method, span name or one span attribute |
| `find_slow_traces` | read | The slowest traces with p50, p95, min and max for context |
| `inspect_trace` | read | Span tree and logs for one trace |
| `inspect_span` | read | Full attribute set for one span; decodes messages and tool calls on AI agent spans |
| `search_logs` | read | Log entries, newest first, filtered by service, severity, body text, trace or span |
| `mine_log_patterns` | read | Cluster log messages into templates with counts and a severity and service breakdown |
| `query_data` | read | Aggregate traces, logs, metrics or product events into a time series or top-N breakdown |
| `run_sql` | read | Run one read-only ClickHouse `SELECT`; see the [SQL reference](/docs/reference/sql) |

### Errors

| Tool | Access | What it does |
| --- | --- | --- |
| `find_errors` | read | Errors grouped by type with counts, affected services and a stable fingerprint |
| `error_detail` | read | Sample traces and correlated logs for one error fingerprint |
| `list_error_issues` | read | Error issues with workflow state, counts, assignee and lease holder |
| `list_error_issue_events` | read | An issue's audit log: state changes, claims, comments, agent notes and fix proposals |
| `list_error_incidents` | read | Time-bounded flare-ups under an error issue (first seen and regressions) |
| `claim_error_issue` | write | Take a lease on an issue so other agents do not duplicate the work |
| `release_error_issue` | write | Give up your lease, optionally moving the issue to another state |
| `transition_error_issue` | write | Move an issue to another workflow state |
| `set_issue_severity` | write | Set or clear an issue's triage severity |
| `comment_on_error_issue` | write | Add a comment or agent note to an issue's timeline |
| `propose_fix` | write | Record a proposed fix and move the issue to `in_review` |
| `link_pull_request` | write | Attach a GitHub pull request to an issue; Maple verifies the fix after it merges |
| `register_agent` | write | Register an LLM agent so it can claim and transition issues. Needs a signed-in user, not an API key |
| `update_error_notification_policy` | write | Choose whether error incidents notify alert destinations, and which ones. Org admins only |

### Alerting

| Tool | Access | What it does |
| --- | --- | --- |
| `list_alert_rules` | read | Alert rules with severity, signal type and condition |
| `get_alert_rule` | read | One rule's full configuration: thresholds, filters, evaluation settings and destinations |
| `list_alert_destinations` | read | Notification destinations with id, type and delivery health |
| `list_alert_incidents` | read | Triggered alert incidents, open and resolved, with the last observed value |
| `get_incident_timeline` | read | Trigger, notification and resolution times for one rule's incidents, or all rules' |
| `list_alert_checks` | read | A rule's recent evaluations with observed value, threshold and sample count |
| `create_alert_rule` | write | Create an alert rule from a template or from signal type, comparator and threshold |
| `update_alert_rule` | write | Change the fields you pass on an alert rule |
| `delete_alert_rule` | write | Delete an alert rule and its incident history. Requires `confirm=true` |

### Dashboards

| Tool | Access | What it does |
| --- | --- | --- |
| `list_dashboards` | read | Dashboards with widget counts and timestamps |
| `get_dashboard` | read | One dashboard's full configuration, every widget included |
| `describe_dashboard_schema` | read | What a widget can be: panel types, data sources, units, aggregations and display options |
| `inspect_chart_data` | read | Run a widget's query and report row counts, series statistics and a health verdict |
| `create_dashboard` | write | Create a dashboard from a template, simplified widget specs or full JSON |
| `update_dashboard` | write | Change a dashboard's name, description or time range |
| `add_dashboard_widget` | write | Add one widget, from the query builder, raw SQL or a funnel |
| `update_dashboard_widget` | write | Replace one widget with a full widget object |
| `remove_dashboard_widget` | write | Remove one widget |
| `reorder_dashboard_widgets` | write | Move or resize widgets |
| `replace_dashboard_widgets` | write | Replace every widget in one validated write |

### Session replays and product events

| Tool | Access | What it does |
| --- | --- | --- |
| `search_sessions` | read | Find browser session replays by user, client, errors, duration or what happened in them |
| `get_session_transcript` | read | A session replay as a text transcript of navigation, clicks, console, network and errors |
| `get_session_traces` | read | The backend traces a browser session produced |
| `list_product_events` | read | Product event names with how often each fired and how many sessions and people it reached |
| `query_funnel` | read | Conversion funnel over product events, with step counts, conversion and drop-off |

### Agent sessions

| Tool | Access | What it does |
| --- | --- | --- |
| `list_agent_sessions` | read | AI agent sessions with agent, models, LLM and tool calls, failures, tokens and cost |
| `get_agent_session` | read | One agent session: verdict, checks, findings, timing, turns, tokens and cost |
| `get_agent_tools_overview` | read | Calls, failures and latency per agent tool, compared with the previous window |
| `get_agent_tool_error` | read | One agent tool failure group with affected sessions and sample calls |

### Setup and source code

| Tool | Access | What it does |
| --- | --- | --- |
| `audit_setup` | read | Check the whole organization setup: alert routing, error notifications and per-service ingest coverage |
| `get_instrumentation_recommendations` | read | Span and resource attribute problems found in your live data |
| `list_source_repositories` | read | Repositories connected through the [GitHub integration](/docs/integrations/github) |
| `search_source_code` | read | Search one connected repository through GitHub code search |
| `read_source_file` | read | Read a line range from a file in a connected repository |

The source-code tools only return results for repositories the organization's GitHub App installation can access.

## Prompts and resources

The server also provides three prompts (`incident_triage`, `latency_analysis`, `debug_errors`) and one resource, `maple://instructions`, which explains Maple's data model to the model.

## Related

- [Maple API](/docs/reference/api): the REST API, with its [OpenAPI spec](/openapi.json)
- [Authentication](/docs/reference/authentication): API keys and OAuth
- [Limits](/docs/reference/limits): query ranges and rate limits
- [llms.txt](/llms.txt): the machine-readable index of this site
