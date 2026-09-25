---
title: "Use Maple with AI agents"
description: "Connect Claude Code, Cursor, Windsurf or any MCP client to Maple, then let the agent debug production errors, chase latency, build dashboards, set up alerts and instrument your code."
group: "Getting Started"
order: 2
navLabel: "AI agents"
---

Your coding agent can work with Maple directly. Connected to the [Maple MCP server](/docs/reference/mcp), it reads the same traces, logs, metrics and error issues you see in the dashboard, and it can act on them: triage an issue, build a dashboard, create an alert rule. Paired with the [GitHub integration](/docs/integrations/github), it can go from an exception to the line of code that raised it.

There are three ways agents fit in:

- **Query and operate Maple** through the MCP server. This page covers it.
- **Instrument your code** with the `maple-onboard` and `maple-audit` skills. See [Instrument with a coding agent](#instrument-with-a-coding-agent).
- **Monitor your own AI agents** in [Agent Sessions](/docs/agent-sessions/overview).

## Connect your agent

Open **Settings → MCP** in Maple. It shows the endpoint for your organization's region and a ready-made configuration for Claude Code, Cursor, Windsurf and other clients.

| Region | Endpoint |
| --- | --- |
| US | `https://api.maple.dev/mcp` |
| EU | `https://api.eu.maple.dev/mcp` |

**With OAuth (recommended).** Add the endpoint URL to your client. On first use it opens Maple in your browser, you pick a workspace and approve access. No key to copy or rotate.

For Claude Code:

```bash
claude mcp add --transport http maple https://api.maple.dev/mcp
```

For Cursor, add this to `.cursor/mcp.json`:

```json
{
	"mcpServers": {
		"maple": {
			"type": "http",
			"url": "https://api.maple.dev/mcp"
		}
	}
}
```

**With an API key.** If your client does not support OAuth, create a key under **Settings → MCP** and send it as a Bearer token:

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

Treat the key like a password. Keep it out of files you commit.

To check the connection, ask your agent: *"List my services in Maple."* It should answer with your services and their error rates.

## What to ask

Plain questions work. The agent picks the tools. Some starting points:

- "What broke in the last hour?"
- "Why is `checkout` slower since yesterday's deploy?"
- "Show me the slowest traces for `POST /orders` today and explain where the time goes."
- "Which errors started after commit `a1b2c3d`?"
- "Build a dashboard for the payments service: throughput, error rate, p95 latency."
- "Alert me in Slack when the API error rate goes over 2% for 5 minutes."
- "Is my instrumentation missing anything?"

You get better answers when you name the **service**, the **time window** and the **environment**. Ask the agent to include trace IDs and the numbers it used, so you can open the evidence in Maple yourself.

## Common workflows

### Debug a production error

1. The agent finds the error with `find_errors` or `list_error_issues`.
2. `error_detail` gives sample occurrences, stack traces and related logs.
3. `inspect_trace` shows the full request: which service called which, and where it failed.
4. With the GitHub integration, `read_source_file` opens the code at the commit that was running.
5. The agent proposes a fix in your repository.

From the **Errors** page you can skip step 1: right-click an issue and choose **Copy agent prompt** to hand your agent the issue with its context.

### Work an error issue end to end

Agents can own issues the same way people do, using the lease described in [Errors](/docs/errors/overview):

1. `claim_error_issue` takes the lease, so two agents (or an agent and a teammate) do not work the same bug.
2. `comment_on_error_issue` records what the agent found.
3. `propose_fix` moves the issue to **In review**.
4. `link_pull_request` attaches the PR. When it merges, Maple watches for new occurrences and verifies the fix.

### Investigate a slowdown

`compare_periods` compares error rate, throughput and p95 between two windows and flags regressions per service. `find_slow_traces` and `get_service_top_operations` narrow it to the endpoint, and `inspect_trace` shows which span grew.

### Build dashboards and alerts

The agent can create dashboards (`create_dashboard`, `add_dashboard_widget`) and alert rules (`create_alert_rule`). A widget that saves is not always a widget that shows the right thing, so ask the agent to check its work with `inspect_chart_data`, which runs the query and reports whether the chart has data.

For heavier dashboard work, give your agent the [maple-dashboard-widgets](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-dashboard-widgets) skill. It documents every panel type, data source and unit.

### Answer anything else with SQL

When no tool fits, `describe_warehouse_tables` lists the tables and columns, and `run_sql` runs a read-only query scoped to your organization. See [SQL](/docs/reference/sql).

## Instrument with a coding agent

Two open-source skills teach a coding agent how to set up OpenTelemetry for Maple:

- [maple-onboard](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-onboard) instruments every app and service in a repository: traces, logs and metrics, using the native OpenTelemetry SDK for each language.
- [maple-audit](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit) reviews an existing setup, reports gaps per service (missing service map edges, missing `service.version`, errors without exceptions) and fixes them.

Add the skill folders to your agent's skills directory, then ask: *"Set up Maple in this repo"* or *"Audit my Maple instrumentation."* With the MCP server connected, the agent can confirm the first traces arrived and run `audit_setup` and `get_instrumentation_recommendations` against your live data.

## Stay in control

- **Read and write tools are separate.** Most tools only read. Tools that change data (triage, dashboards, alert rules) are marked in the [tool list](/docs/reference/mcp#tools). Most clients ask before each tool call; keep approval on for write tools.
- **Deletes need confirmation.** `delete_alert_rule` refuses to run without `confirm=true`.
- **Access is scoped to one organization**, the one the key belongs to or the one you picked at sign-in.
- **Rate limit:** 120 requests per 10 seconds per key or user. Over it, the server answers `429` and the agent should wait 10 seconds.

## Prefer a terminal?

The [`maple` CLI](/docs/reference/cli) outputs JSON by default, so an agent without MCP support can run it and pipe the result into `jq` or its own context.

## Troubleshooting

- **`401 Unauthorized`.** The key was revoked, or the endpoint is in the wrong region. EU organizations use `api.eu.maple.dev`.
- **Empty results.** Check the time window and the service name. Ask the agent to run `list_services` first to see what Maple has.
- **Source code tools return nothing.** They need the [GitHub App](/docs/integrations/github) installed with access to that repository.
- **The agent guesses instead of querying.** Tell it to use Maple: *"Use the maple MCP tools to check."*

## Related

- [MCP server reference](/docs/reference/mcp): endpoints, authentication and every tool
- [Errors](/docs/errors/overview): issue states, leases and fix verification
- [Agent Sessions](/docs/agent-sessions/overview): observe the AI agents you build
- [Authentication](/docs/reference/authentication): API keys and OAuth
