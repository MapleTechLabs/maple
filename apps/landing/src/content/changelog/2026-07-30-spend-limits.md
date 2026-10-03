---
title: "Spend limits, and a billing page built around spend"
description: "See what you've spent this cycle, where it's heading and what drives it, then set a monthly limit and decide what happens when you reach it."
date: 2026-07-30
category: billing
authors: [makisuo]
cover: "/changelog/2026-07-billing.webp"
coverAlt: "The spend-first billing page: current spend, what drives it, and a spend limit."
---

**Settings → Billing** now leads with spend: what you've spent so far this cycle, a projection to
the day the bill closes, and the feature driving it. Logs, traces, metrics and session replays each
get their own card, and a cumulative chart shows how spend built up. An estimated cost section
splits the bill into the base plan and per-feature overage, and past invoices are listed in the app
with a link to each one.

### Spend limits

Set a monthly ceiling on estimated spend and choose what happens when you reach it:

- Keep ingesting, with overage accruing at plan rates.
- **Pause ingest at limit**: data past the limit is rejected until the cycle resets or you raise
  the limit.

You can also cap a single feature. Limits are enforced per signal, so a logs cap never stops your
traces. Maple checks spend against your limits every hour.

Session replays have a size ceiling too: one session records at most 1 GiB, so a single runaway
recording can't grow without bound.
