import type { AttributeFilter } from "@maple/domain"
import {
	normalizeKey,
	parseWhereClause as parseWhereClauses,
	quoteWhereValue,
	type Operator,
	type ParsedClause,
} from "@maple/domain/where-clause"
import { Array as Arr, String as Str } from "effect"

// The signal-agnostic half of a where clause: operators, `attr.*` / `resource.*` predicates and
// `(a OR b)` groups. Each signal (traces, logs) maps its own named fields on top.

/**
 * How an attribute filter compares. Absent means equality; `exists` carries an
 * empty value. `!=`, `!contains` and `!exists` are the same modes with `negated`.
 */
export type AttributeMatchMode = "contains" | "exists" | "gt" | "gte" | "lt" | "lte"

export interface AttributeFilterEntryLeaf {
	key: string
	value: string
	matchMode?: AttributeMatchMode
	negated?: boolean
}

export interface AttributeFilterEntry extends AttributeFilterEntryLeaf {
	/** The other members of an `(a OR b)` group; the entry matches when any member does. */
	or?: readonly AttributeFilterEntryLeaf[]
}

interface AttributeOperator {
	readonly matchMode?: AttributeMatchMode
	readonly negated?: true
}

const ATTRIBUTE_OPERATORS = {
	"=": {},
	"!=": { negated: true },
	contains: { matchMode: "contains" },
	"!contains": { matchMode: "contains", negated: true },
	exists: { matchMode: "exists" },
	"!exists": { matchMode: "exists", negated: true },
	">": { matchMode: "gt" },
	">=": { matchMode: "gte" },
	"<": { matchMode: "lt" },
	"<=": { matchMode: "lte" },
} satisfies Record<Operator, AttributeOperator>

const MATCH_MODE_OPERATORS = {
	contains: ["contains", "!contains"],
	exists: ["exists", "!exists"],
	gt: [">", ">"],
	gte: [">=", ">="],
	lt: ["<", "<"],
	lte: ["<=", "<="],
} as const satisfies Record<AttributeMatchMode, readonly [string, string]>

/** The where-clause operator an attribute filter entry reads back as. */
export function attributeFilterOperator(entry: Pick<AttributeFilterEntry, "matchMode" | "negated">): string {
	if (!entry.matchMode) return entry.negated ? "!=" : "="
	const [positive, negative] = MATCH_MODE_OPERATORS[entry.matchMode]
	return entry.negated ? negative : positive
}

/** An attribute filter entry as where-clause text; a group reads back as `(a OR b)`. */
export function formatAttributeClause(prefix: string, entry: AttributeFilterEntry): string {
	if (entry.or !== undefined && entry.or.length > 0) {
		const { or, ...first } = entry
		return `(${Arr.join(
			Arr.map([first, ...or], (member) => formatAttributeClause(prefix, member)),
			" OR ",
		)})`
	}
	const operator = attributeFilterOperator(entry)
	if (entry.matchMode === "exists") return `${prefix}${entry.key} ${operator}`
	return `${prefix}${entry.key} ${operator} ${quoteWhereValue(entry.value)}`
}

const toQueryLeaf = (entry: AttributeFilterEntryLeaf): AttributeFilter => {
	const mode = entry.matchMode ?? "equals"
	return {
		key: entry.key,
		...(mode === "exists" ? undefined : { value: entry.value }),
		mode,
		...(entry.negated === true ? { negated: true } : undefined),
	}
}

/** An entry as the warehouse request takes it (`mode` instead of `matchMode`). */
export function toQueryAttributeFilter(entry: AttributeFilterEntry): AttributeFilter {
	const { or, ...first } = entry
	return {
		...toQueryLeaf(first),
		...(or !== undefined && or.length > 0 ? { or: Arr.map(or, toQueryLeaf) } : undefined),
	}
}

/** What every signal's parsed clause carries: the two attribute maps. */
export interface AttributeMaps {
	attributeFilters: AttributeFilterEntry[]
	resourceAttributeFilters: AttributeFilterEntry[]
}

const MAX_FILTERS_PER_MAP = 5

/** What a signal's named-field mapper gets for one clause. */
export interface NamedClause {
	readonly clause: ParsedClause
	/** The normalized key (`service.name`, `severity`, ...). */
	readonly key: string
	readonly warnings: string[]
	/** The clause as an attribute predicate on its key as typed (the fallback for unknown keys). */
	readonly pushAttribute: () => void
	/** Reports the operators a named field takes and drops the clause. */
	readonly unsupported: (supported: string) => void
}

/**
 * Parses a where clause: `attr.*` / `resource.*` predicates and OR groups here, every other key
 * through `applyNamed`. One warning per clause that was not applied, for the editor to show.
 */
export function parseFilterClauses<F extends AttributeMaps>(
	whereClause: string | undefined,
	empty: () => F,
	applyNamed: (parsed: F, named: NamedClause) => F,
): { filters: F; warnings: string[] } {
	if (!whereClause || !Str.trim(whereClause)) return { filters: empty(), warnings: [] }

	const parsedClauses = parseWhereClauses(Str.trim(whereClause), { orGroups: true })
	const warnings = Arr.map(parsedClauses.warnings, (warning) => warning.message)

	// Takes `warnings` as a parameter so an OR group member can be applied alone, its warnings apart.
	const applyClause = (parsed: F, clause: ParsedClause, warnings: string[]): F => {
		const key = normalizeKey(clause.key)
		// Attribute keys are case-sensitive, so they come from the key as typed.
		const typedKey = Str.trim(clause.rawKey ?? clause.key)
		const push = (target: AttributeFilterEntry[], attributeKey: string) => {
			if (!attributeKey) {
				warnings.push(`Missing attribute key ignored: ${typedKey}`)
				return
			}
			if (target.length >= MAX_FILTERS_PER_MAP) {
				warnings.push(
					`Maximum of ${MAX_FILTERS_PER_MAP} filters per attribute map; ignoring ${typedKey}`,
				)
				return
			}
			const { matchMode, negated }: AttributeOperator = ATTRIBUTE_OPERATORS[clause.operator]
			target.push({
				key: attributeKey,
				value: matchMode === "exists" ? "" : clause.value,
				...(matchMode ? { matchMode } : undefined),
				...(negated ? { negated } : undefined),
			})
		}
		if (Str.startsWith("attr.")(key)) {
			push(parsed.attributeFilters, Str.trim(Str.slice(5)(typedKey)))
			return parsed
		}
		if (Str.startsWith("resource.")(key)) {
			push(parsed.resourceAttributeFilters, Str.trim(Str.slice(9)(typedKey)))
			return parsed
		}
		return applyNamed(parsed, {
			clause,
			key,
			warnings,
			pushAttribute: () => push(parsed.attributeFilters, typedKey),
			unsupported: (supported) =>
				warnings.push(`${clause.key} supports only ${supported}; ignoring ${clause.operator}`),
		})
	}

	let parsed = Arr.reduce(parsedClauses.clauses, empty(), (acc, clause) =>
		applyClause(acc, clause, warnings),
	)

	// An `(a OR b)` group: each member goes through `applyClause` on its own, and must land as
	// exactly one attribute entry on the same map. Named fields are single-valued and cannot be OR-ed.
	for (const group of parsedClauses.groups) {
		const label = `(${Arr.join(
			Arr.map(group, (c) => c.rawKey ?? c.key),
			" OR ",
		)})`
		const members: Array<{ map: keyof AttributeMaps; entry: AttributeFilterEntry }> = []
		for (const clause of group) {
			const memberWarnings: string[] = []
			const alone = applyClause(empty(), clause, memberWarnings)
			const setsOtherField = Arr.some(
				// @effect-diagnostics-next-line preferEffectRecord:off -- not a record type; Rec.toEntries would need a cast
				Object.entries(alone),
				([field, value]) =>
					field !== "attributeFilters" &&
					field !== "resourceAttributeFilters" &&
					value !== undefined &&
					!(Arr.isArray(value) && value.length === 0),
			)
			const map =
				alone.attributeFilters.length === 1 && alone.resourceAttributeFilters.length === 0
					? "attributeFilters"
					: alone.resourceAttributeFilters.length === 1 && alone.attributeFilters.length === 0
						? "resourceAttributeFilters"
						: undefined
			const entry = map === undefined ? undefined : alone[map][0]
			if (memberWarnings.length > 0 || setsOtherField || map === undefined || entry === undefined) {
				members.length = 0
				warnings.push(`OR group ignored: only attribute filters can be OR-ed: ${label}`)
				break
			}
			members.push({ map, entry })
		}
		const [first, ...rest] = members
		if (first === undefined) continue
		if (Arr.some(rest, (m) => m.map !== first.map)) {
			warnings.push(`OR group ignored: its members mix attribute and resource attributes: ${label}`)
			continue
		}
		if (parsed[first.map].length >= MAX_FILTERS_PER_MAP) {
			warnings.push(`Maximum of ${MAX_FILTERS_PER_MAP} filters per attribute map; ignoring ${label}`)
			continue
		}
		parsed = {
			...parsed,
			[first.map]: [...parsed[first.map], { ...first.entry, or: Arr.map(rest, (m) => m.entry) }],
		}
	}

	return { filters: parsed, warnings }
}

/**
 * An entry as a filter chip reads it: key, connector and value (`http.route` `contains` `/api`).
 * No `operator` means the chip's own is / is not; an OR group reads `Any of (a OR b)`.
 */
export function attributeChipText(
	prefix: string,
	entry: AttributeFilterEntry,
): { label: string; value: string; operator?: string } {
	if (entry.or !== undefined && entry.or.length > 0)
		return { label: "Any of", value: formatAttributeClause(prefix, entry), operator: "" }
	const label = `${prefix}${entry.key}`
	const negated = entry.negated === true
	switch (entry.matchMode) {
		case undefined:
			return { label, value: entry.value }
		case "contains":
			return { label, value: entry.value, operator: negated ? "does not contain" : "contains" }
		case "exists":
			return { label, value: "", operator: negated ? "is not set" : "is set" }
		default:
			return {
				label,
				value: entry.value,
				operator: attributeFilterOperator({ matchMode: entry.matchMode }),
			}
	}
}
