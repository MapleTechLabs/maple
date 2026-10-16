---
"@maple-dev/effect-sdk": minor
---

`Maple.layer` takes the same span options as `MapleFlush.make` and the Cloudflare `make`, and all three classify spans the same way. New on every preset: `dropSpanSubtrees` drops a span and everything under it, `dropSpan` drops a finished span by predicate, and `isAnticipatedError` is the predicate form of `anticipatedErrorIdentifiers`. A server span that answered 5xx stays an error even when its failure is anticipated. On `Maple.layer`, unmatched-route 404 spans are now dropped and server spans that rendered a 5xx are recorded as errors, which can surface new error groups.
