import type { Operator } from "@maple/domain/where-clause"
import { whereKeyMatchesAnyOf, whereKeyRule, whereOperatorsOf } from "@maple/query-engine/query-builder"
import {
	getWhereClauseAutocomplete,
	type WhereClauseAutocompleteValues,
} from "../../../lib/query-builder/where-clause-autocomplete"
import { Array as Arr, Option, Schema, String as Str } from "effect"
import type { QueryDraft } from "./draft"

// The condition builder's vocabulary: which fields a query offers (grouped like a path picker),
// the operators a field takes, and the values it suggests, all read from the where editor's
// autocomplete values.

type DataSource = QueryDraft["dataSource"]

export type FieldGroup = "common" | "resource" | "attribute"
export type FieldKind = "string" | "number" | "boolean"
export type ConditionField = Readonly<{ key: string; label: string; group: FieldGroup; kind: FieldKind }>

const common = (key: string, label: string, kind: FieldKind = "string"): ConditionField => ({
	key,
	label,
	group: "common",
	kind,
})

const COMMON_FIELDS = {
	traces: [
		common("service.name", "Service"),
		common("span.name", "Span name"),
		common("deployment.environment", "Environment"),
		common("attr.http.response.status_code", "HTTP status code", "number"),
		common("has_error", "Has error", "boolean"),
		common("min_duration_ms", "Min duration (ms)", "number"),
		common("max_duration_ms", "Max duration (ms)", "number"),
		common("vcs.ref.head.revision", "Commit"),
		common("root_only", "Root spans only", "boolean"),
	],
	logs: [common("service.name", "Service"), common("severity", "Severity"), common("body", "Message")],
	metrics: [
		common("service.name", "Service"),
		common("deployment.environment", "Environment"),
		common("metric.type", "Metric type"),
	],
	product_events: [
		common("event.name", "Event name"),
		common("host", "Host"),
		common("page.path", "Page path"),
		common("service.name", "Service"),
		common("user.id", "User"),
	],
} satisfies Record<DataSource, ReadonlyArray<ConditionField>>

const ATTRIBUTE_GROUP_LABEL = {
	traces: "Span attributes",
	logs: "Log attributes",
	metrics: "Metric attributes",
	product_events: "Event properties",
} satisfies Record<DataSource, string>

export const groupLabelOf = (group: FieldGroup, dataSource: DataSource): string =>
	group === "common"
		? "Common"
		: group === "resource"
			? "Resource attributes"
			: ATTRIBUTE_GROUP_LABEL[dataSource]

const NUMERIC_KEY = /(status_code|_ms|duration|\.port|\.count|\.size|_bytes)$/

const kindOfKey = (key: string): FieldKind => (NUMERIC_KEY.test(key) ? "number" : "string")

const RESOURCE_PREFIX = "resource."
const ATTRIBUTE_PREFIX = "attr."

/** A key as a field: a common one by name, else its attribute group with the prefix dropped. */
export const fieldOf = (key: string, dataSource: DataSource): ConditionField => {
	const known = Option.getOrNull(Arr.findFirst(COMMON_FIELDS[dataSource], (field) => field.key === key))
	if (known !== null) return known
	if (Str.startsWith(RESOURCE_PREFIX)(key))
		return { key, label: Str.slice(RESOURCE_PREFIX.length)(key), group: "resource", kind: kindOfKey(key) }
	const label = Str.startsWith(ATTRIBUTE_PREFIX)(key) ? Str.slice(ATTRIBUTE_PREFIX.length)(key) : key
	return { key, label, group: "attribute", kind: kindOfKey(key) }
}

/** Whether the query engine ORs this field's values (`whereKeyMatchesAnyOf`: attribute filters only). */
export const canMatchAnyOf = (field: ConditionField, dataSource: DataSource): boolean =>
	field.kind !== "boolean" && whereKeyMatchesAnyOf(dataSource, field.key)

/** A key another control owns: the traces span select writes `root_only`. */
export const isOwnedElsewhere = (key: string, dataSource: DataSource): boolean =>
	dataSource === "traces" && key === "root_only"

/** Every field the query offers: the common ones, then resource and own attributes as the editor writes them. */
export const fieldsOf = (
	dataSource: DataSource,
	values: WhereClauseAutocompleteValues,
): ReadonlyArray<ConditionField> =>
	Arr.dedupeWith(
		[
			...Arr.filter(COMMON_FIELDS[dataSource], (field) => !isOwnedElsewhere(field.key, dataSource)),
			...Arr.map(values.resourceAttributeKeys ?? [], (key) =>
				fieldOf(`${RESOURCE_PREFIX}${key}`, dataSource),
			),
			...Arr.map(values.attributeKeys ?? [], (key) => fieldOf(`${ATTRIBUTE_PREFIX}${key}`, dataSource)),
		],
		(a, b) => a.key === b.key,
	)

// The field picker's list: a drill-down over the groups, flat while searching.

export const FieldDrill = Schema.Literals(["all", "resource", "attribute"])
export type FieldDrill = typeof FieldDrill.Type

export type FieldPickerItem =
	| Readonly<{ _tag: "Field"; value: string; field: ConditionField }>
	| Readonly<{ _tag: "Group"; value: string; group: "resource" | "attribute"; count: number }>
	| Readonly<{ _tag: "Back"; value: string }>
	| Readonly<{ _tag: "Custom"; value: string; key: string }>

const GROUP_VALUE = "@group:"
const BACK_VALUE = "@back"
const CUSTOM_VALUE = "@custom:"
const KEY_PATTERN = /^[a-zA-Z0-9_.-]+$/

const asField = (field: ConditionField): FieldPickerItem => ({ _tag: "Field", value: field.key, field })

const matchesQuery = (field: ConditionField, query: string): boolean => {
	const needle = Str.toLowerCase(query)
	return (
		Str.includes(needle)(Str.toLowerCase(field.key)) || Str.includes(needle)(Str.toLowerCase(field.label))
	)
}

/** What a typed key means inside a group: the group's prefix unless it already has one. */
const customKeyOf = (typed: string, drill: FieldDrill, fields: ReadonlyArray<ConditionField>): string => {
	if (Str.startsWith(RESOURCE_PREFIX)(typed) || Str.startsWith(ATTRIBUTE_PREFIX)(typed)) return typed
	if (drill === "resource") return `${RESOURCE_PREFIX}${typed}`
	if (drill === "all" && Arr.some(fields, (field) => field.group === "common" && field.key === typed))
		return typed
	return `${ATTRIBUTE_PREFIX}${typed}`
}

export const fieldPickerItems = (
	fields: ReadonlyArray<ConditionField>,
	drill: FieldDrill,
	query: string,
): ReadonlyArray<FieldPickerItem> => {
	const typed = Str.trim(query)
	const inScope = drill === "all" ? fields : Arr.filter(fields, (field) => field.group === drill)
	const back: ReadonlyArray<FieldPickerItem> = drill === "all" ? [] : [{ _tag: "Back", value: BACK_VALUE }]
	if (typed !== "") {
		const key = customKeyOf(typed, drill, fields)
		const custom: ReadonlyArray<FieldPickerItem> =
			KEY_PATTERN.test(typed) && !Arr.some(fields, (field) => field.key === key)
				? [{ _tag: "Custom", value: `${CUSTOM_VALUE}${key}`, key }]
				: []
		return [
			...Arr.map(
				Arr.filter(inScope, (field) => matchesQuery(field, typed)),
				asField,
			),
			...custom,
		]
	}
	if (drill !== "all") return [...back, ...Arr.map(inScope, asField)]
	const groupNames: ReadonlyArray<"resource" | "attribute"> = ["resource", "attribute"]
	const groups = Arr.flatMap(groupNames, (group): ReadonlyArray<FieldPickerItem> => {
		const count = Arr.filter(fields, (field) => field.group === group).length
		return count === 0 ? [] : [{ _tag: "Group", value: `${GROUP_VALUE}${group}`, group, count }]
	})
	return [
		...Arr.map(
			Arr.filter(fields, (field) => field.group === "common"),
			asField,
		),
		...groups,
	]
}

// Operators and values.

const KIND_OPERATORS = {
	number: ["=", "!=", ">", ">=", "<", "<=", "exists", "!exists"],
	boolean: ["=", "!=", "exists", "!exists"],
	string: ["=", "!=", "contains", "!contains", "exists", "!exists"],
} satisfies Record<FieldKind, ReadonlyArray<Operator>>

/**
 * The operators a field takes on its source (the engine's `whereOperatorsOf`); a map attribute
 * takes every operator, narrowed to its kind. A row's current operator always stays offered.
 */
export const operatorsOf = (
	field: ConditionField,
	dataSource: DataSource,
	current?: Operator,
): ReadonlyArray<Operator> => {
	const accepted = whereOperatorsOf(dataSource, field.key)
	const own: ReadonlyArray<Operator> =
		whereKeyRule(dataSource, field.key)._tag === "Attribute"
			? Arr.filter(KIND_OPERATORS[field.kind], (operator) => accepted.includes(operator))
			: accepted
	return current === undefined || own.includes(current) ? own : [...own, current]
}

export const OPERATOR_LABEL = {
	"=": "is",
	"!=": "is not",
	contains: "contains",
	"!contains": "does not contain",
	">": "greater than",
	">=": "at least",
	"<": "less than",
	"<=": "at most",
	exists: "is set",
	"!exists": "is not set",
} satisfies Record<Operator, string>

/** Known values for a field: what the where editor would suggest after `key = `. */
export const valueSuggestionsOf = (
	field: ConditionField,
	dataSource: DataSource,
	values: WhereClauseAutocompleteValues,
): ReadonlyArray<string> => {
	if (field.kind === "boolean") return ["true", "false"]
	if (Str.endsWith("status_code")(field.key)) return values.httpStatusCodes ?? []
	const expression = `${field.key} = `
	const { suggestions } = getWhereClauseAutocomplete({
		expression,
		cursor: expression.length,
		dataSource,
		values,
		maxSuggestions: 200,
	})
	return Arr.dedupe(
		Arr.map(
			Arr.filter(suggestions, (suggestion) => suggestion.kind === "value"),
			(suggestion) => suggestion.label,
		),
	)
}
