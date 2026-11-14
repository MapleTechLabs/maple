import { Array as Arr, Effect } from "effect"
import {
	DataSourceValidationError,
	type ResourceFilter,
	type ResourceScalar,
} from "@maple/domain/data-sources"
import { didYouMean } from "../suggest"
import { toEpochMs } from "./time"
import type { ResolvedFilter, ResourceDefinition, ResourceFieldDef } from "./types"

export const invalid = (message: string, field?: string) =>
	Effect.fail(new DataSourceValidationError(field === undefined ? { message } : { message, field }))

/** The field by name, or a validation error naming the closest fields. */
export const fieldOf = (def: ResourceDefinition, name: string, role: string) =>
	Arr.findFirst(def.fields, (field) => field.name === name).pipe((found) =>
		found._tag === "Some"
			? Effect.succeed(found.value)
			: invalid(
					`\`${def.name}\` has no field \`${name}\` (used as ${role}).${didYouMean(
						name,
						Arr.map(def.fields, (field) => field.name),
					)}`,
					name,
				),
	)

/** Refuses PII fields when the caller may not read them, and filter-only fields outside filters. */
export const checkReadable = (field: ResourceFieldDef, role: string, redactPii: boolean) =>
	redactPii && field.pii === true
		? invalid(
				`\`${field.name}\` is personal data and this caller may not read it (used as ${role}). Use ids or counts, or ask an admin to allow agents to read PII on this source.`,
				field.name,
			)
		: field.filterOnly === true && role !== "a filter"
			? invalid(`\`${field.name}\` can only be used in filters`, field.name)
			: Effect.void

const show = (value: ResourceScalar): string => (typeof value === "string" ? `"${value}"` : String(value))

const scalarFor = (field: ResourceFieldDef, value: ResourceScalar) => {
	if (field.type === "timestamp") {
		const ms = toEpochMs(value)
		return ms === null
			? invalid(
					`\`${field.name}\` takes epoch milliseconds or an ISO timestamp, got ${show(value)}`,
					field.name,
				)
			: Effect.succeed<ResourceScalar>(ms)
	}
	if (field.type === "number" && typeof value !== "number") {
		return invalid(`\`${field.name}\` is a number, got ${show(value)}`, field.name)
	}
	if (field.type === "boolean" && typeof value !== "boolean") {
		return invalid(`\`${field.name}\` is true or false, got ${show(value)}`, field.name)
	}
	return Effect.succeed(value)
}

const ORDERED = new Set(["gt", "gte", "lt", "lte"])

const isList = (
	value: ResourceScalar | ReadonlyArray<ResourceScalar>,
): value is ReadonlyArray<ResourceScalar> => typeof value === "object"

/** Checks one filter's op and value against its field and normalizes timestamps to epoch ms. */
export const resolveFilter = (
	field: ResourceFieldDef,
	filter: ResourceFilter,
	window: { readonly startMs: number; readonly endMs: number },
): Effect.Effect<ReadonlyArray<ResolvedFilter>, DataSourceValidationError> => {
	if (field.capabilities.filter === "none")
		return invalid(`\`${field.name}\` cannot be filtered on`, field.name)
	if (filter.op === "within_window") {
		return field.type === "timestamp"
			? Effect.succeed([
					{ field: field.name, op: "gte", value: window.startMs },
					{ field: field.name, op: "lt", value: window.endMs },
				])
			: invalid(
					`\`within_window\` needs a timestamp field; \`${field.name}\` is ${field.type}`,
					field.name,
				)
	}
	const op = filter.op
	const value = filter.value
	if (value === undefined)
		return invalid(`The \`${op}\` filter on \`${field.name}\` needs a value`, field.name)
	if (op === "in") {
		return isList(value) && value.length > 0
			? Effect.map(
					Effect.forEach(value, (item) => scalarFor(field, item)),
					(values) => [{ field: field.name, op, value: values }],
				)
			: invalid(`\`in\` on \`${field.name}\` takes a non-empty list`, field.name)
	}
	if (isList(value))
		return invalid(`\`${op}\` on \`${field.name}\` takes one value; use \`in\` for a list`, field.name)
	if (ORDERED.has(op) && field.type !== "number" && field.type !== "timestamp") {
		return invalid(
			`\`${op}\` needs a number or timestamp field; \`${field.name}\` is ${field.type}`,
			field.name,
		)
	}
	if (op === "contains" && field.type !== "string") {
		return invalid(`\`contains\` needs a text field; \`${field.name}\` is ${field.type}`, field.name)
	}
	return Effect.map(scalarFor(field, value), (scalar) => [{ field: field.name, op, value: scalar }])
}

export const isServerFilter = (def: ResourceDefinition, filter: ResolvedFilter): boolean =>
	Arr.findFirst(def.fields, (field) => field.name === filter.field).pipe(
		(found) =>
			found._tag === "Some" &&
			found.value.capabilities.filter === "server" &&
			Arr.contains(found.value.serverOps, filter.op),
	)

/** True when Maple must apply this filter to fetched rows: the API cannot, or only prefilters. */
export const isClientFilter = (def: ResourceDefinition, filter: ResolvedFilter): boolean =>
	!isServerFilter(def, filter) ||
	Arr.some(def.fields, (field) => field.name === filter.field && field.recheck === true)
