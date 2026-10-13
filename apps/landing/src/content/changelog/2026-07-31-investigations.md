---
title: "Issues, investigations and escalations in one workflow"
description: "AI investigations get their own workspace, can read your connected GitHub source, and feed escalation policies you can test before saving."
date: 2026-07-31
category: ai
authors: [makisuo]
cover: "/changelog/2026-07-investigations.webp"
coverAlt: "Investigations: an issue, its investigation thread, an evidence-backed diagnosis and an approved action."
---

AI triage used to be spread across short-lived runs, cards and chat panels. It is now one
workflow: an issue opens an investigation, the investigation produces a diagnosis backed by
evidence, proposed actions wait for approval, and every escalation is recorded.

- **Investigations.** Every investigation is listed under **Investigations** in the sidebar and
  opens in a workspace with the transcript, diagnosis, evidence, actions and approvals. Error
  issues, alerts and anomalies all open the same kind of investigation. Transcripts are stored, so
  a reload or another device shows the full thread, and tool results render as structured views
  instead of raw JSON.
- **Source code.** With the [GitHub integration](/docs/integrations/github) connected, an
  investigation can search and read your repositories at the commit your telemetry reports, so a
  finding can point at the code involved. Access is read-only, and source findings stay hypotheses
  until telemetry confirms them.
- **Settings → Automation.** Automatic investigations, severity and confidence routing, and recent
  escalation deliveries share one page. The **Policy simulator** shows whether a given severity,
  source and AI confidence would escalate, and to which destinations, before you change anything.

Learn how issues work in the [errors guide](/docs/errors/overview).
