/** Which map an attribute lives in: `LogAttributes` or `ResourceAttributes`. */
export type LogAttributeSource = "log" | "resource"

export interface LogAttributeFilter {
	source: LogAttributeSource
	key: string
	value: string
	negated: boolean
}

/**
 * URL spelling of one filter, an entry of the `attrs` search param:
 * `[!]log:<key>=<value>` or `[!]res:<key>=<value>`. The value is everything
 * after the first `=`, so it may hold `=` itself; the key escapes `%` and `=`.
 */
export function encodeLogAttributeFilter(filter: LogAttributeFilter): string {
	const key = filter.key.replace(/%/g, "%25").replace(/=/g, "%3D")
	const scope = filter.source === "resource" ? "res" : "log"
	return `${filter.negated ? "!" : ""}${scope}:${key}=${filter.value}`
}

const ENTRY = /^(!?)(log|res):([^=]+)=([\s\S]*)$/

/** `undefined` for an entry that is not in the `attrs` spelling, so a hand-edited URL drops it. */
export function decodeLogAttributeFilter(entry: string): LogAttributeFilter | undefined {
	const match = ENTRY.exec(entry)
	if (!match) return undefined
	const [, bang, scope, rawKey, value] = match
	const key = rawKey.replace(/%(25|3D)/gi, (escape) => (escape === "%25" ? "%" : "="))
	return { source: scope === "res" ? "resource" : "log", key, value, negated: bang === "!" }
}

export function decodeLogAttributeFilters(entries: readonly string[] | undefined): LogAttributeFilter[] {
	return (entries ?? []).flatMap((entry) => {
		const filter = decodeLogAttributeFilter(entry)
		return filter ? [filter] : []
	})
}

/**
 * Adds a filter to the `attrs` list. The same key and value in the other
 * polarity is replaced rather than kept beside it, since both together match nothing.
 */
export function addLogAttributeFilter(
	entries: readonly string[] | undefined,
	filter: LogAttributeFilter,
): string[] {
	const opposite = encodeLogAttributeFilter({ ...filter, negated: !filter.negated })
	const next = encodeLogAttributeFilter(filter)
	const kept = (entries ?? []).filter((entry) => entry !== opposite && entry !== next)
	return [...kept, next]
}

/** One exact-match predicate, the shape the logs warehouse requests take. */
export interface LogAttributeQueryFilter {
	key: string
	value: string
	mode: "equals"
	negated?: boolean
}

/** The warehouse request fields for the `attrs` entries, `undefined` when there are none. */
export function logAttributeQueryFilters(entries: readonly string[] | undefined): {
	attributeFilters: LogAttributeQueryFilter[] | undefined
	resourceAttributeFilters: LogAttributeQueryFilter[] | undefined
} {
	const filters = decodeLogAttributeFilters(entries)
	const toQuery = (source: LogAttributeSource): LogAttributeQueryFilter[] | undefined => {
		const matching = filters
			.filter((filter) => filter.source === source)
			.map((filter) => {
				const query: LogAttributeQueryFilter = {
					key: filter.key,
					value: filter.value,
					mode: "equals",
				}
				if (filter.negated) query.negated = true
				return query
			})
		return matching.length > 0 ? matching : undefined
	}
	return { attributeFilters: toQuery("log"), resourceAttributeFilters: toQuery("resource") }
}

/** Client-side match of one row against the filters, for surfaces that filter a fixture (the lab). */
export function matchesLogAttributeFilters(
	filters: readonly LogAttributeFilter[],
	attributes: { log: Record<string, string>; resource: Record<string, string> },
): boolean {
	return filters.every((filter) => {
		const actual = (filter.source === "resource" ? attributes.resource : attributes.log)[filter.key] ?? ""
		return (actual === filter.value) !== filter.negated
	})
}
