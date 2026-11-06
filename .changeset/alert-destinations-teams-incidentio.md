---
"@maple-dev/alchemy": minor
---

`Maple.AlertDestination` accepts `type: "microsoft-teams"` with a `webhook_url` (a Teams Workflows webhook) and `type: "incident-io"` with an `alert_source_config_id` and `token` (an incident.io HTTP alert source).

`Maple.AlertDestination` attributes gain `channelLabel` (the Telegram chat ID or incident.io alert source ID, otherwise null), so a channel changed outside IaC shows up as drift.
