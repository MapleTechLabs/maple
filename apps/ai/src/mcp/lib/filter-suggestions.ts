/**
 * "Did you mean" hints for an empty result. A filter value that matches nothing
 * (a service spelled `maple-alerting` instead of `alerting`, environment `stg`, a
 * short span name) otherwise reads as "no data", which agents take at face value.
 */

const editDistance = (a: string, b: string): number => {
	const previous = Array.from({ length: b.length + 1 }, (_, j) => j)
	for (let i = 1; i <= a.length; i++) {
		let diagonal = previous[0]!
		previous[0] = i
		for (let j = 1; j <= b.length; j++) {
			const above = previous[j]!
			previous[j] = Math.min(above + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
			diagonal = above
		}
	}
	return previous[b.length]!
}

/** `stg` for `staging`: the input's letters, in order, from the same first letter. */
const abbreviates = (short: string, long: string): boolean => {
	if (short.length < 2 || short[0] !== long[0]) return false
	let at = 0
	for (const letter of long) if (letter === short[at]) at++
	return at === short.length
}

/**
 * Up to `max` candidates closest to `input`: substring matches either way first
 * (`alerting` for `maple-alerting`), then small edit distances. Exact matches excluded.
 */
export const closestMatches = (
	input: string,
	candidates: ReadonlyArray<string>,
	max = 3,
): ReadonlyArray<string> => {
	const needle = input.toLowerCase()
	if (needle.length === 0) return []
	const scored: Array<{ readonly name: string; readonly score: number }> = []
	for (const name of new Set(candidates)) {
		const hay = name.toLowerCase()
		if (hay === needle) {
			// Same value in another case is the best possible suggestion.
			if (name !== input) scored.push({ name, score: -1 })
			continue
		}
		if (hay.length > 0 && (hay.includes(needle) || needle.includes(hay))) {
			scored.push({ name, score: Math.abs(hay.length - needle.length) / 1000 })
			continue
		}
		const distance = editDistance(needle, hay)
		if (distance <= Math.max(2, Math.floor(needle.length / 3))) scored.push({ name, score: distance })
		else if (abbreviates(needle, hay)) scored.push({ name, score: 2.5 })
	}
	return scored
		.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
		.slice(0, max)
		.map((s) => s.name)
}

export interface RequestedFilters {
	readonly service?: string | undefined
	readonly environments?: ReadonlyArray<string> | undefined
	readonly attributeKey?: string | undefined
	readonly spanName?: string | undefined
}

/** Values that exist in the window. A missing list means "unknown": no hint for it. */
export interface KnownValues {
	readonly services?: ReadonlyArray<string>
	/** False when `services` is a capped top-N, so absence from it proves nothing. */
	readonly servicesComplete?: boolean
	readonly environments?: ReadonlyArray<string>
	/** Same as `servicesComplete`, for `environments`. */
	readonly environmentsComplete?: boolean
	readonly attributeKeys?: ReadonlyArray<string>
	readonly spanNames?: ReadonlyArray<string>
}

const quoted = (values: ReadonlyArray<string>) => values.map((v) => `"${v}"`).join(", ")

const hintFor = (
	label: string,
	value: string,
	known: ReadonlyArray<string> | undefined,
	complete: boolean,
	whereToLook: string,
): string | undefined => {
	if (known === undefined || known.includes(value)) return undefined
	const close = closestMatches(value, known)
	if (close.length > 0) return `${label} "${value}" was not seen in this window. Did you mean ${quoted(close)}?`
	return complete ? `${label} "${value}" was not seen in this window; ${whereToLook}.` : undefined
}

/** One hint per requested filter value that does not exist in the window. */
export const missingFilterHints = (
	requested: RequestedFilters,
	known: KnownValues,
): ReadonlyArray<string> => {
	const hints: Array<string | undefined> = []
	if (requested.service !== undefined) {
		hints.push(
			hintFor(
				"service",
				requested.service,
				known.services,
				known.servicesComplete ?? true,
				"list_services lists the services that reported",
			),
		)
	}
	for (const environment of requested.environments ?? []) {
		hints.push(
			hintFor(
				"environment",
				environment,
				known.environments,
				known.environmentsComplete ?? true,
				"explore_attributes source=services lists the environments",
			),
		)
	}
	if (requested.attributeKey !== undefined) {
		hints.push(
			hintFor(
				"attribute_key",
				requested.attributeKey,
				known.attributeKeys,
				false,
				"explore_attributes lists attribute keys",
			),
		)
	}
	if (requested.spanName !== undefined) {
		hints.push(
			hintFor(
				"span_name",
				requested.spanName,
				known.spanNames,
				false,
				"get_service_top_operations lists span names",
			),
		)
	}
	return hints.filter((hint): hint is string => hint !== undefined)
}
