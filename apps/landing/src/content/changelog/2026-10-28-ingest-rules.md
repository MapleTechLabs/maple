---
title: "Ingest rules: drop and redact data before it is stored"
description: "Drop noisy logs, spans and metrics, or redact personal data and secrets, before Maple stores or bills them."
date: 2026-10-28
category: platform
authors: [makisuo]
---

You can now write **ingest rules** that run on your telemetry as it arrives, before it is stored
or counted toward your bill.

- **Drop** logs, spans or metrics you don't need: health checks, debug logs from one service, a
  chatty metric. You can drop all of them or keep a percentage.
- **Redact** values in place, such as email addresses, tokens or card numbers in log bodies and
  attributes.

Find them under **Settings → Ingestion → Ingest rules**. The editor reads as a sentence (when,
where, then) and has a **live preview**: it runs the rule against your 100 newest logs or spans
from the last hour and shows what would be dropped and each value before and after redaction.
The empty state offers templates to start from.

Each rule shows its hits over the last 24 hours. **Billing & usage** shows how much data rules
dropped in the current cycle, which is not billed. Rules are also available through the
`/v2/ingest_rules` API.
