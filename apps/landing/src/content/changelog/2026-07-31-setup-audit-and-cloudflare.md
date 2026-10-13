---
title: "Setup audit, Cloudflare over OAuth, and a new Ingestion page"
description: "Check your whole Maple setup in one report, connect Cloudflare without Logpush or an agent, and find your endpoint and keys in one place."
date: 2026-07-31
category: integrations
authors: [makisuo]
---

- **Setup audit.** Open **Settings → Setup Audit** for a report of 41 checks across alerting,
  ingest coverage, attributes and trace completeness. It catches problems that otherwise fail
  silently: an alert rule routed to a deleted destination, a service whose logs and traces use
  different `service.name` values, or traces with spans whose parent never arrived. The same report
  is available through the `audit_setup` MCP tool.
- **Cloudflare over OAuth.** Connect a Cloudflare account from **Integrations** and Maple pulls its
  analytics for you, with no Logpush jobs or agent to run. Cloudflare gets its own page under
  **Infrastructure → Cloudflare**, and zone analytics can be filtered by path, country and client.
- **Ingestion settings.** **Settings → Ingestion** puts your endpoint and keys on one card, with a
  live status banner showing whether data is arriving. API keys can be revealed from a masked
  value, and you set scopes and expiry when you create one.
- **Integrations.** The integrations list, empty states and drill-ins were redesigned. Searching
  Kubernetes and host lists now filters in place instead of reloading the page.
- **Local mode** gained metrics, services and errors views, plus telemetry archives.
- **Chat anywhere.** Maple AI moved out of the sidebar into a slide-over you can open from any
  page. Press `C`, or use the button in the header.

Get started with the [Cloudflare integration](/docs/integrations/cloudflare).
