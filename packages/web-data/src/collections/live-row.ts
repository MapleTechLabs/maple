import { Option, Result, Schema } from "effect"

/**
 * Live-row decoding that cannot throw.
 *
 * Mappers run inside live-query callbacks, outside any Effect, so a throw there takes the
 * whole page down. A newer server can sync a value this build has never seen (a new
 * signal type, a new kind), so a row that fails to decode is dropped and reported, never
 * thrown. `maple/no-throwing-live-row-decode` keeps sync decodes out of this directory.
 */

/** A schema's encoded fields, each still unchecked: what a mapper assembles from a synced row. */
export type UncheckedFields<S extends { readonly Encoded: unknown }> = {
	readonly [K in keyof S["Encoded"]]: unknown
}

export interface UndecodableRow {
	readonly collection: string
	readonly rowId: string
	readonly message: string
}

type UndecodableRowListener = (row: UndecodableRow) => void

const listeners = new Set<UndecodableRowListener>()
// Live queries re-map every row on each change; report a bad row once, not on every tick.
const reported = new Set<string>()

/** Subscribe to dropped rows (the shell logs them and probes for a newer build). */
export const onUndecodableRow = (listener: UndecodableRowListener): (() => void) => {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

const report = (row: UndecodableRow): void => {
	const key = `${row.collection}:${row.rowId}`
	// Unheard reports are not spent: a listener that subscribes later still hears the row.
	if (listeners.size === 0 || reported.has(key)) return
	reported.add(key)
	for (const listener of listeners) listener(row)
}

/** Decodes one value of a row; `None` (reported) drops the row it belongs to. */
export const liveValueDecoder = <S extends Schema.ConstraintDecoder<unknown>>(
	collection: string,
	schema: S,
) => {
	const decode = Schema.decodeUnknownResult(schema)
	return (rowId: string, value: unknown): Option.Option<S["Type"]> =>
		Result.match(decode(value), {
			onSuccess: Option.some,
			onFailure: (error) => {
				report({ collection, rowId, message: error.message })
				return Option.none()
			},
		})
}

/**
 * One decode per row, against the whole domain schema: `Some` when every field is readable,
 * `None` (reported) when any is not.
 */
export const liveRowDecoder = <S extends Schema.ConstraintDecoder<unknown>>(
	collection: string,
	schema: S,
): ((rowId: string, fields: UncheckedFields<S>) => Option.Option<S["Type"]>) =>
	liveValueDecoder(collection, schema)
