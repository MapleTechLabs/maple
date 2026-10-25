// Span filtering + error classification options, shared by every preset
// (`Maple.layer`, `MapleFlush.make`, and the Cloudflare `make`) so they accept
// the same options and classify a given span the same way.
//
// BOUNDARY: a span's failure can be any value, so error predicates take `unknown`
// and `failureIdentifier` narrows it.
import { Predicate } from "effect"
import type { Exit, Tracer } from "effect"

/** A finished span, as handed to the `dropSpan` predicate. */
export interface FinishedSpan {
	readonly name: string
	readonly kind: Tracer.SpanKind
	readonly attributes: ReadonlyMap<string, unknown>
	readonly exit: Exit.Exit<unknown, unknown>
}

export interface MapleSpanOptions {
	/**
	 * Span name prefixes to drop before OTLP export. Only the matching span is
	 * dropped: its children still export (with a parent that never arrives). Use
	 * `dropSpanSubtrees` to drop the children too.
	 */
	readonly dropSpanNames?: ReadonlyArray<string> | undefined
	/**
	 * Span name prefixes whose span AND every descendant are dropped. The span is
	 * started unsampled, so children inherit that and nothing under it exports,
	 * whatever its name (DB queries, HTTP client calls, ...).
	 *
	 * Two side effects worth knowing before reaching for it: outgoing HTTP calls
	 * under a dropped span send `traceparent` with the sampled flag off, so
	 * downstream services that honour it drop their part of the trace too; and
	 * errors inside the subtree never reach error tracking. Keep real work (e.g.
	 * processing a job a poll found) out of the dropped span.
	 */
	readonly dropSpanSubtrees?: ReadonlyArray<string> | undefined
	/**
	 * Called on each finished span; returning `true` drops it (children are not
	 * affected). Use when a name prefix isn't enough, e.g. dropping only polls
	 * that found nothing: `(span) => span.attributes.get("queue.empty") === true`.
	 */
	readonly dropSpan?: ((span: FinishedSpan) => boolean) | undefined
	/**
	 * Stable `_tag` / `Error.name` identifiers of expected failures (validation,
	 * not-found, duplicate, ...). A span failing entirely with these exports as
	 * status `Ok` with no `exception` event: still visible, never an error. A
	 * failure wrapped in an `{ error: … }` envelope is matched on the body's
	 * `_tag`. A server span that answered 5xx stays `Error` regardless.
	 */
	readonly anticipatedErrorIdentifiers?: ReadonlyArray<string> | undefined
	/** @deprecated Use `anticipatedErrorIdentifiers`. */
	readonly anticipatedErrorTags?: ReadonlyArray<string> | undefined
	/**
	 * Predicate form of `anticipatedErrorIdentifiers`, for failures a tag can't
	 * single out (e.g. a driver error that is only expected for a duplicate key).
	 * Either matching makes the failure anticipated.
	 */
	readonly isAnticipatedError?: ((error: unknown) => boolean) | undefined
}

/** Internal input: sets are accepted wherever the public options take arrays. */
export interface SpanFilterInput {
	readonly dropSpanNames?: Iterable<string> | undefined
	readonly dropSpanSubtrees?: Iterable<string> | undefined
	readonly dropSpan?: ((span: FinishedSpan) => boolean) | undefined
	readonly anticipatedErrorIdentifiers?: Iterable<string> | undefined
	readonly anticipatedErrorTags?: Iterable<string> | undefined
	readonly isAnticipatedError?: ((error: unknown) => boolean) | undefined
	/**
	 * Append each error's `[cause]` chain to `exception.stacktrace`, as Effect's
	 * stock `OtlpTracer` does. Fingerprints hash the top stack frames, so a
	 * preset keeps whatever it shipped with to avoid re-splitting error groups.
	 */
	readonly includeCauseInStack?: boolean | undefined
}

export interface SpanFilter {
	readonly dropSubtree: ((name: string) => boolean) | undefined
	readonly drop: ((span: FinishedSpan) => boolean) | undefined
	readonly isAnticipated: ((error: unknown) => boolean) | undefined
	readonly includeCauseInStack: boolean
}

const prefixMatcher = (prefixes: Iterable<string> | undefined): ((name: string) => boolean) | undefined => {
	const list = prefixes === undefined ? [] : [...prefixes]
	return list.length > 0 ? (name) => list.some((prefix) => name.startsWith(prefix)) : undefined
}

// A failure's stable identifier: its `_tag`, else its `Error.name`. An error
// that crossed an HTTP boundary arrives as a decoded *body*, so an API that
// wraps bodies in `{ error: … }` hands over a plain object with no identifier of
// its own; unwrap one level, and only for the body's own tag.
export const failureIdentifier = (error: unknown): string | undefined => {
	if (Predicate.hasProperty(error, "_tag") && typeof error._tag === "string") return error._tag
	if (Predicate.hasProperty(error, "name") && typeof error.name === "string") return error.name
	const body = Predicate.hasProperty(error, "error") ? error.error : undefined
	if (Predicate.hasProperty(body, "_tag") && typeof body._tag === "string") return body._tag
	return undefined
}

export const resolveSpanFilter = (input: SpanFilterInput = {}): SpanFilter => {
	const dropName = prefixMatcher(input.dropSpanNames)
	const dropPredicate = input.dropSpan
	const drop =
		dropName !== undefined && dropPredicate !== undefined
			? (span: FinishedSpan) => dropName(span.name) || dropPredicate(span)
			: dropName !== undefined
				? (span: FinishedSpan) => dropName(span.name)
				: dropPredicate

	const identifiers = new Set([
		...(input.anticipatedErrorIdentifiers ?? []),
		...(input.anticipatedErrorTags ?? []),
	])
	const byIdentifier =
		identifiers.size > 0
			? (error: unknown) => {
					const identifier = failureIdentifier(error)
					return identifier !== undefined && identifiers.has(identifier)
				}
			: undefined
	const byPredicate = input.isAnticipatedError
	const isAnticipated =
		byIdentifier !== undefined && byPredicate !== undefined
			? (error: unknown) => byIdentifier(error) || byPredicate(error)
			: (byIdentifier ?? byPredicate)

	return {
		dropSubtree: prefixMatcher(input.dropSpanSubtrees),
		drop,
		isAnticipated,
		includeCauseInStack: input.includeCauseInStack ?? false,
	}
}
