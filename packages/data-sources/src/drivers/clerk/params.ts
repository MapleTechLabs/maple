import { Array as Arr, Effect } from "effect"
import { DataSourceValidationError, type ResourceScalar } from "@maple/domain/data-sources"
import type { ResolvedFilter, ServerFilterOp } from "../../resource-engine/types"

/** How one field's filters become Clerk query parameters. */
export interface ParamMapping<N extends string> {
	/** Exclusive epoch-ms bounds (`*_after` / `*_before`). */
	readonly range?: { readonly after: N; readonly before: N }
	/** Repeated parameter for `eq` / `in` (Clerk accepts up to 100 values). */
	readonly values?: N
	/** Case-insensitive partial match for `contains`. */
	readonly contains?: N
	readonly bool?: N
}

export const MAX_VALUES = 100

export const serverOpsOf = <N extends string>(mapping: ParamMapping<N>): ReadonlyArray<ServerFilterOp> => [
	...(mapping.range === undefined ? [] : (["gt", "gte", "lt", "lte"] as const)),
	...(mapping.values === undefined ? [] : (["eq", "in"] as const)),
	...(mapping.contains === undefined ? [] : (["contains"] as const)),
	...(mapping.bool === undefined ? [] : (["eq"] as const)),
]

const list = (value: ResolvedFilter["value"]): ReadonlyArray<ResourceScalar> =>
	typeof value === "object" ? value : [value]

const num = (value: ResolvedFilter["value"]) => (typeof value === "number" ? value : Number(value))

/**
 * Server filters to parameters. Clerk documents `*_after` / `*_before` as "after" / "before" a
 * date, which Maple reads as exclusive: `gte x` sends `after x-1`, `lt x` sends `before x`.
 * Clerk takes integer ms and timestamps are integers, so fractional bounds round to the same set.
 */
export const toParams = <N extends string>(
	mappings: ReadonlyMap<string, ParamMapping<N>>,
	filters: ReadonlyArray<ResolvedFilter>,
): Effect.Effect<ReadonlyArray<readonly [N, string]>, DataSourceValidationError> =>
	Effect.map(
		Effect.forEach(Arr.fromIterable(mappings), ([field, mapping]) => {
			const mine = Arr.filter(filters, (f) => f.field === field)
			const lowers = Arr.flatMap(mine, (f) =>
				f.op === "gte"
					? [Math.ceil(num(f.value)) - 1]
					: f.op === "gt"
						? [Math.floor(num(f.value))]
						: [],
			)
			const uppers = Arr.flatMap(mine, (f) =>
				f.op === "lt"
					? [Math.ceil(num(f.value))]
					: f.op === "lte"
						? [Math.floor(num(f.value)) + 1]
						: [],
			)
			const range = mapping.range
			const rangeParams: ReadonlyArray<readonly [N, string]> =
				range === undefined
					? []
					: [
							...(lowers.length === 0
								? []
								: [[range.after, String(Math.max(...lowers))] as const]),
							...(uppers.length === 0
								? []
								: [[range.before, String(Math.min(...uppers))] as const]),
						]
			const values = Arr.flatMap(mine, (f) => (f.op === "eq" || f.op === "in" ? list(f.value) : []))
			if (values.length > MAX_VALUES) {
				return Effect.fail(
					new DataSourceValidationError({
						message: `Clerk takes at most ${MAX_VALUES} values for \`${field}\``,
						field,
					}),
				)
			}
			const valueName = mapping.bool ?? mapping.values
			const valueParams =
				valueName === undefined ? [] : Arr.map(values, (v) => [valueName, String(v)] as const)
			const contains = mapping.contains
			const containsParams =
				contains === undefined
					? []
					: Arr.flatMap(mine, (f) =>
							f.op === "contains" ? [[contains, String(f.value)] as const] : [],
						)
			return Effect.succeed([...rangeParams, ...valueParams, ...containsParams])
		}),
		Arr.flatten,
	)
