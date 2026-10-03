---
title: "Errors and issues are now one triage list"
description: "Every error row now shows its volume, its trend and its triage state together, so you can prioritize from a single page."
date: 2026-08-19
category: errors
authors: [makisuo]
---

The **Errors** page and the **Issues** page used to show the same errors from two angles: one knew how often each error fired, the other knew who was working on it. They are now a single list at `/errors`.

Each row carries the error's event count, a trend sparkline, and one status. If an incident is open, the row shows that. Otherwise it shows a running investigation, and otherwise the issue's workflow state. The four KPI cards at the top became one stat line, so the list starts above the fold.

The issue page was reworked to match:

- The culprit (top stack frame) and fingerprint sit directly under the title, with the exception message as the main text.
- A time range picker drives the occurrence chart, the samples and the event count together.
- Content is split into **Overview**, **Occurrences** and **Activity** tabs.

Old `/errors/issues` links redirect to the equivalent view.

Read the [Errors guide](/docs/errors/overview) for the full triage workflow.
