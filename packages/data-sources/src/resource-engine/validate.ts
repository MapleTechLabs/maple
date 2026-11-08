import { Array as Arr, Effect, Option } from "effect"
import {
	type DataSourceValidationError,
	MAX_RESOURCE_LIST_LIMIT,
	type ResourceExternalQuery,
	type ResourceMeasure,
	type SourceCatalog,
} from "@maple/domain/data-sources"
import type { QueryRequest } from "../port"
import { didYouMean } from "../suggest"
import { checkReadable, fieldOf, invalid, isClientFilter, isServerFilter, resolveFilter } from "./fields"
import type { ResolvedFilter, ResourceDefinition, ResourceFieldDef } from "./types"

export const DEFAULT_LIST_LIMIT = 100

export interface ValidatedQuery {
	readonly def: ResourceDefinition
	readonly measure: { readonly fn: ResourceMeasure["fn"]; readonly field: ResourceFieldDef | null } | null
	readonly timeGroup: ResourceFieldDef | null
	readonly groupField: ResourceFieldDef | null
	readonly serverFilters: ReadonlyArray<ResolvedFilter>
	readonly clientFilters: ReadonlyArray<ResolvedFilter>
	readonly select: ReadonlyArray<ResourceFieldDef>
	readonly orderBy: { readonly field: string; readonly dir: "asc" | "desc" } | null
	readonly limit: number
}

const NUMERIC_ONLY = new Set(["sum", "avg"])

const resourceOf = (definitions: ReadonlyArray<ResourceDefinition>, catalog: SourceCatalog, name: string) => {
	// Admins can hide catalog entries; an empty catalog (never refreshed) exposes every declared resource.
	const exposed =
		catalog.entries.length === 0
			? definitions
			: Arr.filter(definitions, (def) => Arr.some(catalog.entries, (entry) => entry.name === def.name))
	const found = Arr.findFirst(exposed, (candidate) => candidate.name === name)
	if (Option.isNone(found)) {
		return invalid(
			`No resource \`${name}\` on this source.${didYouMean(
				name,
				Arr.map(exposed, (d) => d.name),
			)} Resources: ${Arr.join(
				Arr.map(exposed, (d) => `\`${d.name}\``),
				", ",
			)}.`,
			"resource",
		)
	}
	const def = found.value
	const override = Option.getOrUndefined(
		Arr.findFirst(catalog.entries, (entry) => entry.name === name),
	)?.timeField
	const timeField =
		override !== undefined && Arr.some(def.fields, (f) => f.name === override && f.type === "timestamp")
			? override
			: def.timeField
	return Effect.succeed({ ...def, timeField })
}

const measureOf = (def: ResourceDefinition, measure: ResourceMeasure, redactPii: boolean) =>
	Effect.gen(function* () {
		if (measure.fn === "count") return { fn: measure.fn, field: null }
		if (measure.field === undefined) return yield* invalid(`\`${measure.fn}\` needs a field`, "measure")
		const field = yield* fieldOf(def, measure.field, "the measure")
		yield* checkReadable(field, "the measure", redactPii)
		if (!field.capabilities.measure)
			return yield* invalid(`\`${field.name}\` cannot be measured`, field.name)
		const numeric =
			field.type === "number" || (field.type === "timestamp" && !NUMERIC_ONLY.has(measure.fn))
		if (measure.fn !== "count_distinct" && !numeric) {
			return yield* invalid(
				`\`${measure.fn}\` needs a numeric field; \`${field.name}\` is ${field.type}`,
				field.name,
			)
		}
		return { fn: measure.fn, field }
	})

const timeGroupOf = (def: ResourceDefinition, name: string, redactPii: boolean) =>
	Effect.gen(function* () {
		const field = yield* fieldOf(def, name, "the time group")
		yield* checkReadable(field, "the time group", redactPii)
		if (field.type !== "timestamp")
			return yield* invalid(`\`${field.name}\` is not a timestamp`, field.name)
		if (field.latestOnly === true) {
			return yield* invalid(
				`\`${field.name}\` holds only each ${def.noun.one}'s most recent value, so grouping it by time would move every ${def.noun.one} to their latest bucket and undercount every earlier one. ` +
					`Answerable instead: ${def.noun.many} with \`${field.name}\` inside the window (count with filter \`{ "field": "${field.name}", "op": "within_window" }\`), or since a date (filter \`gte\` an epoch ms).`,
				field.name,
			)
		}
		return field
	})

/** Checks a resource query against the declared resource; nothing is fetched. */
export const validateResourceQuery = (
	definitions: ReadonlyArray<ResourceDefinition>,
	catalog: SourceCatalog,
	query: ResourceExternalQuery,
	request: QueryRequest,
): Effect.Effect<ValidatedQuery, DataSourceValidationError> =>
	Effect.gen(function* () {
		const def = yield* resourceOf(definitions, catalog, query.resource)
		const redact = request.redactPii
		const measure = query.measure === undefined ? null : yield* measureOf(def, query.measure, redact)
		const timeGroup =
			query.groupBy?.time === undefined ? null : yield* timeGroupOf(def, query.groupBy.time, redact)
		const groupField =
			query.groupBy?.field === undefined ? null : yield* fieldOf(def, query.groupBy.field, "the group")
		if (groupField !== null) {
			yield* checkReadable(groupField, "the group", redact)
			if (!groupField.capabilities.group) {
				return yield* invalid(`\`${groupField.name}\` cannot be grouped by`, groupField.name)
			}
		}
		if (measure === null && (timeGroup !== null || groupField !== null)) {
			return yield* invalid('`groupBy` needs a `measure` (for example `{ "fn": "count" }`)', "groupBy")
		}
		const filters = yield* Effect.forEach(query.filters ?? [], (filter) =>
			Effect.gen(function* () {
				const field = yield* fieldOf(def, filter.field, "a filter")
				yield* checkReadable(field, "a filter", redact)
				return { field, resolved: yield* resolveFilter(field, filter, request.window) }
			}),
		)
		const valueFields = Arr.filter(filters, (f) =>
			Arr.some(f.resolved, (r) => r.op === "eq" || r.op === "in"),
		)
		const names = Arr.map(valueFields, (f) => f.field.name)
		const dupe = Arr.findFirst(names, (name, i) =>
			Arr.some(Arr.take(names, i), (earlier) => earlier === name),
		)
		if (Option.isSome(dupe))
			return yield* invalid(`Combine the \`${dupe.value}\` filters into one \`in\``, dupe.value)
		// The window binds to the time group, else to the default time field when no filter names a timestamp.
		const named = (name: string) => Arr.some(filters, (f) => f.field.name === name)
		const bindTo =
			timeGroup !== null
				? named(timeGroup.name)
					? null
					: timeGroup.name
				: Arr.some(filters, (f) => f.field.type === "timestamp")
					? null
					: def.timeField
		const windowFilters: ReadonlyArray<ResolvedFilter> =
			bindTo === null
				? []
				: [
						{ field: bindTo, op: "gte", value: request.window.startMs },
						{ field: bindTo, op: "lt", value: request.window.endMs },
					]
		const resolved = [...windowFilters, ...Arr.flatMap(filters, (f) => f.resolved)]
		const select = yield* selectOf(def, query, redact)
		const orderBy = query.orderBy === undefined ? null : query.orderBy
		if (orderBy !== null) {
			const field = yield* fieldOf(def, orderBy.field, "the order")
			yield* checkReadable(field, "the order", redact)
			if (!field.capabilities.sort) {
				const sortable = Arr.join(
					Arr.map(
						Arr.filter(def.fields, (f) => f.capabilities.sort),
						(f) => `\`${f.name}\``,
					),
					", ",
				)
				return yield* invalid(
					`\`${field.name}\` cannot be sorted by; sortable fields: ${sortable}`,
					field.name,
				)
			}
		}
		return {
			def,
			measure,
			timeGroup,
			groupField,
			serverFilters: Arr.filter(resolved, (f) => isServerFilter(def, f)),
			clientFilters: Arr.filter(resolved, (f) => isClientFilter(def, f)),
			select,
			orderBy,
			limit: Math.min(
				query.limit ?? DEFAULT_LIST_LIMIT,
				MAX_RESOURCE_LIST_LIMIT,
				request.limits.maxRows,
			),
		}
	})

const selectOf = (def: ResourceDefinition, query: ResourceExternalQuery, redactPii: boolean) =>
	query.select === undefined || query.select.length === 0
		? Effect.succeed(Arr.filter(def.fields, (field) => field.pii !== true && field.filterOnly !== true))
		: Effect.forEach(query.select, (name) =>
				Effect.tap(fieldOf(def, name, "a selected field"), (field) =>
					checkReadable(field, "a selected field", redactPii),
				),
			)
