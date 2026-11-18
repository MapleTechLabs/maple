---
"@maple-dev/alchemy": minor
---

`Maple.StatusPage` declares a status page: its settings, theme, components, visibility, password and custom domain, applied through the page's config document. Components keep their IDs by name, an unset `manual_status` leaves a responder's override alone, and the `customDomain` output lists the DNS records to create.

`Maple.UptimeMonitor` declares an HTTP, TCP, DNS, multi-step or heartbeat monitor, so a status page component's `monitor_id` can come from the same stack.

`MapleApiContract` gains `put`; a custom `MapleApi` implementation needs to add it.
