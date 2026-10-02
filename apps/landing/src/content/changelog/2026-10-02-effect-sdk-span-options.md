---
title: "Drop noisy spans and expected errors from Maple.layer"
description: "Maple.layer now takes the same span options as MapleFlush.make, plus subtree drops and predicates for both."
date: 2026-10-02
category: sdk
authors: [makisuo]
---

`Maple.layer`, the long-running preset in `@maple-dev/effect-sdk`, now accepts the span options
that were only on `MapleFlush.make` and the Cloudflare `make`. All three presets take the same
options and classify spans the same way.

- `dropSpanNames` drops spans by name prefix, as before. Only the matching span goes.
- `dropSpanSubtrees` drops a span and every span under it, so an idle polling loop and the
  queries it runs stop exporting. Outgoing calls under a dropped span carry an unsampled
  `traceparent`, and errors inside it are not tracked, so keep real work outside it.
- `dropSpan` takes a predicate on the finished span (name, kind, attributes, exit), for example
  to drop only polls that found nothing.
- `anticipatedErrorIdentifiers` marks expected failures (a duplicate, a not-found) as `Ok` with
  no exception, so they stop creating error groups. `isAnticipatedError` is its predicate form,
  for driver errors that are only expected in one case.
- `excludeLogSpans` is now available on `Maple.layer` too.

A few behaviour changes come with it:

- A server span that answered 5xx stays an error even when its failure is listed as anticipated.
- On `Maple.layer`, spans for unmatched-route 404s are dropped, and server spans that rendered a
  5xx response are recorded as errors, matching the other presets. That can surface new error
  groups for crashes that used to export as `Ok`.

Upgrade to `@maple-dev/effect-sdk` 0.10.0. It needs `effect` between 4.0.0-rc.113 and rc.117.
