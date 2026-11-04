// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
// Dashboard variable interpolation
//
// Resolves `$name` / `${name}` references inside widget data-source params
// before the query is dispatched. Pure module — fully unit-testable.
//
// Variable names always start with a letter (enforced by the domain schema),
// so references can never collide with the `$__` built-in macros
// ($__startTime, $__timeFilter(...), ...), which are left untouched for the
// backend raw-SQL macro expansion.
//
// Formatting is key-aware:
//   - `sql` values get self-quoted, escaped ClickHouse string literals so a
//     crafted variable value cannot break out of its literal position.
//   - `whereClause`-like values are handled clause-by-clause: a clause that
//     references an "All" selection is dropped entirely (All = don't filter),
//     and a value that would change a clause's predicates is not substituted.
//   - everything else gets plain text substitution.

import { escapeClickHouseString } from "@maple-dev/effect-orm/sql"
import { parseWhereClause, splitWhereClause } from "@maple/domain/where-clause"
import { Schema, Array as Arr, Record as Rec, String as Str, Predicate } from "effect"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Sentinel for the "All" selection, both in URLs and resolved values. */
export const ALL_VALUE = "$__all"

export interface ResolvedVariable {
	/** The selected value, or `ALL_VALUE` when the All option is active. */
	value: string
	isAll: boolean
	/** Current option list — used to expand an All selection inside SQL `IN ($var)`. */
	options: string[]
}

export type VariableValues = Record<string, ResolvedVariable | undefined>

// `${name}` first so the branch consumes the braces; both forms require a
// leading letter, which is what keeps `$__` macros out of reach.
const VAR_REF = /\$\{([A-Za-z][A-Za-z0-9_]*)\}|\$([A-Za-z][A-Za-z0-9_]*)/g

const WHERE_CLAUSE_KEY = /whereclause$/i

function sqlLiteral(variable: ResolvedVariable): string {
	if (variable.isAll) {
		if (variable.options.length === 0) return "''"
		return Arr.join(
			Arr.map(variable.options, (option) => `'${escapeClickHouseString(option)}'`),
			",",
		)
	}
	return `'${escapeClickHouseString(variable.value)}'`
}

function replaceRefs(input: string, resolve: (name: string) => string | null): string {
	return input.replace(VAR_REF, (match, braced: string | undefined, bare: string | undefined) => {
		const replacement = resolve(braced ?? bare ?? "")
		// Unknown (or deleted) variable: keep the reference literal so the query
		// returns no rows instead of silently matching everything.
		return replacement ?? match
	})
}

/** Extract every `$name` / `${name}` reference in a string. */
export function collectVariableRefs(input: string): string[] {
	const names: string[] = []
	for (const match of Str.matchAll(VAR_REF)(input)) {
		const name = match[1] ?? match[2]
		if (name && !names.includes(name)) names.push(name)
	}
	return names
}

/** Strings outside `*whereClause` keys: the places an "All" expands into option values. */
const expandedStrings = (value: unknown, key?: string): string[] => {
	if (key !== undefined && WHERE_CLAUSE_KEY.test(key)) return []
	if (typeof value === "string") return [value]
	if (Arr.isArray(value)) return Arr.flatMap(value, (item) => expandedStrings(item, key))
	if (Predicate.isObject(value))
		return Arr.flatMap(Rec.toEntries<string, unknown>(value), ([childKey, child]) =>
			expandedStrings(child, childKey),
		)
	return []
}

/**
 * Variables referenced where an "All" expands to the option list (SQL, values); a `whereClause`
 * drops the clause for "All" instead, so it needs no options.
 */
export function collectExpandedVariableRefs(params: unknown): string[] {
	return collectVariableRefs(Arr.join(expandedStrings(params), "\n"))
}

/** Each resolved reference replaced by its value, or by `placeholder` when given; unknown ones stay literal. */
const substituteClause = (clause: string, values: VariableValues, placeholder?: string): string =>
	replaceRefs(clause, (name) => {
		const variable = values[name]
		return variable === undefined ? null : (placeholder ?? variable.value)
	})

type Predicate = readonly [key: string, operator: string]

interface ClausePredicates {
	readonly clauses: ReadonlyArray<Predicate>
	readonly groups: ReadonlyArray<ReadonlyArray<Predicate>>
	readonly unparsed: number
}

const predicatesOf = (text: string): ClausePredicates => {
	const parsed = parseWhereClause(text, { orGroups: true })
	const predicate = (clause: { key: string; operator: string }): Predicate => [clause.key, clause.operator]
	return {
		clauses: Arr.map(parsed.clauses, predicate),
		groups: Arr.map(parsed.groups, (group) => Arr.map(group, predicate)),
		unparsed: parsed.warnings.length,
	}
}

const CLAUSE_AFTER = "maple.next exists"

/** No quote or parenthesis is left open, so a clause joined after this one still splits off on its own. */
const closesCleanly = (text: string): boolean => {
	const parts = splitWhereClause(`${text} AND ${CLAUSE_AFTER}`)
	return parts[parts.length - 1] === CLAUSE_AFTER
}

/** `$filter` alone: the value is the clause, so only its closing is checked. */
const WHOLE_CLAUSE_REF = /^\$(?:\{[A-Za-z][A-Za-z0-9_]*\}|[A-Za-z][A-Za-z0-9_]*)$/

/**
 * Whether `actual` parses to the template's predicates. A key that differs between the two
 * placeholder parses is the variable's own key position, so any key matches there.
 */
const predicatesMatch = (
	actual: ReadonlyArray<Predicate>,
	a: ReadonlyArray<Predicate>,
	b: ReadonlyArray<Predicate>,
) =>
	actual.length === a.length &&
	a.length === b.length &&
	Arr.every(a, ([key, operator], i) => {
		const [actualKey, actualOperator] = actual[i]
		return actualOperator === operator && (actualKey === key || key !== b[i][0])
	})

/**
 * A substituted clause closes cleanly and parses to the same predicates (keys, operators, OR
 * groups, unparsed parts) as the clause with neutral placeholders. A value carrying a quote, a
 * parenthesis or ` AND ` changes that; an ordinary service name never does.
 */
const keepsClausePredicates = (clause: string, values: VariableValues): boolean => {
	if (collectVariableRefs(clause).length === 0) return true
	const substituted = substituteClause(clause, values)
	if (!closesCleanly(substituted)) return false
	if (WHOLE_CLAUSE_REF.test(Str.trim(clause))) return true
	const a = predicatesOf(substituteClause(clause, values, "v"))
	const b = predicatesOf(substituteClause(clause, values, "w"))
	const actual = predicatesOf(substituted)
	return (
		actual.unparsed === a.unparsed &&
		predicatesMatch(actual.clauses, a.clauses, b.clauses) &&
		actual.groups.length === a.groups.length &&
		a.groups.length === b.groups.length &&
		Arr.every(a.groups, (group, i) => predicatesMatch(actual.groups[i], group, b.groups[i]))
	)
}

/** Every clause of `template` keeps its parsed shape once `values` are substituted into it. */
export const keepsWhereClausePredicates = (template: string, values: VariableValues): boolean =>
	Arr.every(splitWhereClause(template), (clause) => keepsClausePredicates(clause, values))

// A whereClause is `clause AND clause AND ...`. An "All" selection means "don't filter on
// this at all", so the clause carrying the reference is removed rather than substituted.
// Splitting uses the engine's where-clause grammar, so a quoted value containing " and " is
// never mis-split. A value that would change a clause's predicates is not substituted: the
// reference stays literal, so in a value position the clause matches nothing, and no other
// clause is dropped with it.
function interpolateWhereClause(input: string, values: VariableValues): string {
	const kept: string[] = []
	for (const clause of splitWhereClause(input)) {
		const refs = collectVariableRefs(clause)
		const dropped = Arr.some(refs, (name) => values[name]?.isAll === true)
		if (dropped) continue
		kept.push(keepsClausePredicates(clause, values) ? substituteClause(clause, values) : clause)
	}
	return Arr.join(kept, " AND ")
}

/** Every string under a `*whereClause` key, at any depth: the templates a variable can land in. */
export const collectWhereClauses = (value: unknown, key?: string): string[] => {
	if (typeof value === "string") return key !== undefined && WHERE_CLAUSE_KEY.test(key) ? [value] : []
	if (Arr.isArray(value)) return Arr.flatMap(value, (item) => collectWhereClauses(item, key))
	if (typeof value === "object" && value !== null)
		return Arr.flatMap(Rec.toEntries(value), ([childKey, child]) => collectWhereClauses(child, childKey))
	return []
}

function interpolateString(input: string, key: string | undefined, values: VariableValues): string {
	if (!Str.includes("$")(input)) return input
	if (key === "sql") {
		return replaceRefs(input, (name) => {
			const variable = values[name]
			return variable === undefined ? null : sqlLiteral(variable)
		})
	}
	if (key !== undefined && WHERE_CLAUSE_KEY.test(key)) {
		return interpolateWhereClause(input, values)
	}
	return replaceRefs(input, (name) => {
		const variable = values[name]
		if (variable === undefined) return null
		return variable.isAll ? Arr.join(variable.options, ",") : variable.value
	})
}

function walk(value: unknown, key: string | undefined, values: VariableValues): unknown {
	if (typeof value === "string") return interpolateString(value, key, values)
	if (Arr.isArray(value)) return Arr.map(value, (item) => walk(item, key, values))
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [childKey, childValue] of Rec.toEntries(value)) {
			out[childKey] = walk(childValue, childKey, values)
		}
		return out
	}
	return value
}

/**
 * Deep-interpolate `$name` references throughout widget params. Nested
 * structures (e.g. `queries[i].whereClause`) inherit the nearest object key
 * for format selection.
 */
export function interpolateWidgetParams(
	params: Record<string, unknown>,
	values: VariableValues,
): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	for (const [key, value] of Rec.toEntries(params)) {
		result[key] = walk(value, key, values)
	}
	return result
}

/**
 * Interpolate references in user-facing display text (widget titles,
 * descriptions). Unlike query interpolation, an "All" selection renders as
 * the word "All" — not the expanded value list.
 */
export function interpolateDisplayText(text: string, values: VariableValues): string {
	if (!Str.includes("$")(text)) return text
	return replaceRefs(text, (name) => {
		const variable = values[name]
		if (variable === undefined) return null
		return variable.isAll ? "All" : variable.value
	})
}

/**
 * True when the params reference a *defined* variable that has no resolved
 * value yet (query-variable options still loading and nothing pins a value).
 * Widget fetches gate on this so a literal `$service` never reaches the API.
 */
export function hasUnresolvedVariableRefs(
	params: Record<string, unknown> | undefined,
	definedNames: ReadonlyArray<string>,
	values: VariableValues,
): boolean {
	if (!params || definedNames.length === 0) return false
	const refs = collectVariableRefs(encodeJson(params))
	return Arr.some(refs, (name) => definedNames.includes(name) && values[name] === undefined)
}
