# @maple-dev/effect-sdk

## 0.11.0

### Minor Changes

- 832b7db: `Maple.layer` takes the same span options as `MapleFlush.make` and the Cloudflare `make`, and all three classify spans the same way. New on every preset: `dropSpanSubtrees` drops a span and everything under it, `dropSpan` drops a finished span by predicate, and `isAnticipatedError` is the predicate form of `anticipatedErrorIdentifiers`. A server span that answered 5xx stays an error even when its failure is anticipated. On `Maple.layer`, unmatched-route 404 spans are now dropped and server spans that rendered a 5xx are recorded as errors, which can surface new error groups.

## 0.10.2

### Patch Changes

- 737e082: Raw HTTP client spans no longer open error issues for failures the caller already handled. A 4xx client span keeps its `Error` status but no longer carries an `exception` event, so error tracking leaves the issue to the caller's span: one that does not handle the 4xx still fails and reports it. In the browser preset, a request that fails in transport while the page was hidden, unloading or offline exports as `Unset` with the reason in `maple.connection_lost`.

## 0.10.1

### Patch Changes

- ed8a412: A 5xx server span keeps its `HttpServerErrorResponse` exception on Effect 4.0.2 and later, which now fails the span itself with an `HttpServerError` for any 5xx response. Without this, those responses were grouped as one generic `HttpServerError` issue.
