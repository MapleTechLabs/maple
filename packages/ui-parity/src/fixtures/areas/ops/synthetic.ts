import { DateTime, Predicate } from "effect"

/** Pure value noise: the same key and time always give the same number, whatever the call order. */
export const noise = (key: string, at: number): number => {
	const hash = Array.from(`${key}:${at}`).reduce(
		(acc, char) => (Math.imul(acc, 2654435761) + char.charCodeAt(0)) >>> 0,
		17,
	)
	return ((Math.imul(hash ^ (hash >>> 15), 2246822519) >>> 0) % 10_000) / 10_000
}

export const str = (value: unknown, key: string): string | undefined => {
	const field = Predicate.hasProperty(value, key) ? value[key] : undefined
	return typeof field === "string" ? field : undefined
}

export const num = (value: unknown, key: string): number | undefined => {
	const field = Predicate.hasProperty(value, key) ? value[key] : undefined
	return typeof field === "number"
		? field
		: typeof field === "string" && field !== ""
			? Number(field)
			: undefined
}

export const strings = (value: unknown, key: string): ReadonlyArray<string> => {
	const field = Predicate.hasProperty(value, key) ? value[key] : undefined
	return Array.isArray(field) ? field.filter((item): item is string => typeof item === "string") : []
}

export const iso = (ms: number): string => new Date(ms).toISOString()

export const list = (data: ReadonlyArray<unknown>) => ({
	object: "list",
	data,
	has_more: false,
	next_cursor: null,
})

/** Epoch ms of an ISO-8601 instant with its zone (dataset clocks, v2 query timestamps). */
export const epochMs = (value: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(value))

/** A fixed table's entry for a key read from data, if it has one. */
export const lookup = <V>(table: Readonly<Record<string, V>>, key: string): V | undefined =>
	Object.hasOwn(table, key) ? table[key] : undefined
