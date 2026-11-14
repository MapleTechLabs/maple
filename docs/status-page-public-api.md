# Status page public API

Every public status page serves JSON next to its HTML, on its Maple address and its custom
domain alike. The status Worker (`apps/status`) renders both from the published snapshot, with
no call into Maple. Responses carry `access-control-allow-origin: *` and the page's cache
(`max-age=15`, stale for a day if the Worker errors).

## `GET /api/v1/status.json`

A statuspage.io-style summary: the overall indicator, each component's status, open incidents
and scheduled maintenance, and `status.delayed` when live checks have stopped.

## `GET /api/v1/uptime.json`

Daily uptime of each component that shows uptime bars on the page. Components without a
monitor, or with uptime hidden, are left out.

| Query       |                                                                                   |
| ----------- | --------------------------------------------------------------------------------- |
| `days`      | Days back from today (UTC), 1 to 365. Default 90, the page's window.              |
| `component` | One component's id (as in `status.json`); 404 when no component with bars has it. |

```json
{
	"page": {
		"id": "…",
		"name": "Acme",
		"url": "https://acme.example",
		"status_url": "https://status.acme.com",
		"time_zone": "Etc/UTC"
	},
	"days": 90,
	"components": [
		{
			"id": "…",
			"name": "API",
			"group": "Platform",
			"uptime_percent": 99.9712,
			"days": [{ "date": "2026-11-10", "uptime_percent": 100, "status": "operational" }]
		}
	],
	"generated_at": "2026-11-11T14:05:00.000Z"
}
```

Uptime is the share of checks not taken while the monitor was down, floored to 4 decimals, so
a day with any downtime never reads 100. `uptime_percent` is `null` and `status` is `no_data`
for a day without checks; `status` is otherwise `operational`, `degraded` (some checks failed)
or `down`. A bad `days` is a 400 with `{ "error": "…" }`.

## Other routes

`/badge.svg` (the overall status as a badge), `/feed.atom` and `/feed.rss` (incidents and
maintenance).
